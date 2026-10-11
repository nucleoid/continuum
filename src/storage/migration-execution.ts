import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

const unsafeClients = new WeakSet<pg.PoolClient>();

export function executionClientIsUnsafe(client: pg.PoolClient): boolean {
  return unsafeClients.has(client);
}

export async function rollbackExecutionTransaction(client: pg.PoolClient, error: unknown): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    unsafeClients.add(client);
    throw new AggregateError([error, rollbackError],
      'Migration transaction failed and rollback failed', { cause: error });
  }
  throw error;
}

export function sqlHash(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Constant-space evidence for operative SQL, not control reads or ledger writes. */
export class MigrationExecution {
  readonly attemptId = randomUUID();
  private readonly hash = createHash('sha256');
  statementCount = 0;

  constructor(
    readonly name: string,
    readonly phase: string,
    readonly variant: string,
    readonly sourceHash: string | null,
    readonly effectiveHash: string,
    readonly dependencyHash: string | null = null,
  ) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    client: pg.PoolClient, sql: string, values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    const result = await client.query<T>(sql, values);
    for (const value of [sql, JSON.stringify(values)]) {
      const bytes = Buffer.from(value, 'utf8');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length);
      this.hash.update(size).update(bytes);
    }
    this.statementCount += 1;
    return result;
  }

  async start(client: pg.PoolClient): Promise<void> {
    const incompatible = await client.query(
      `SELECT 1 FROM _continuum_migration_execution
        WHERE migration_name=$1 AND phase=$2 AND state='started'
          AND (variant<>$3 OR source_sha256 IS DISTINCT FROM $4
            OR effective_sql_sha256 IS DISTINCT FROM $5
            OR dependency_source_sha256 IS DISTINCT FROM $6) LIMIT 1`,
      [this.name, this.phase, this.variant, this.sourceHash, this.effectiveHash, this.dependencyHash],
    );
    if (incompatible.rowCount) throw new Error('Migration execution recipe changed during an incomplete attempt');
    await client.query(
      `INSERT INTO _continuum_migration_execution
        (attempt_id,migration_name,phase,variant,source_sha256,effective_sql_sha256,
         dependency_source_sha256,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,'started')`,
      [this.attemptId, this.name, this.phase, this.variant, this.sourceHash,
        this.effectiveHash, this.dependencyHash],
    );
  }

  async hasCompleted(client: pg.PoolClient): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM _continuum_migration_execution
        WHERE migration_name=$1 AND phase=$2 AND state='completed'
          AND variant=$3 AND source_sha256 IS NOT DISTINCT FROM $4
          AND effective_sql_sha256=$5
          AND dependency_source_sha256 IS NOT DISTINCT FROM $6 LIMIT 1`,
      [this.name, this.phase, this.variant, this.sourceHash, this.effectiveHash, this.dependencyHash],
    );
    return result.rowCount === 1;
  }

  async complete(client: pg.PoolClient, started = false): Promise<void> {
    const digest = this.hash.copy().digest('hex');
    if (started) {
      const updated = await client.query(
        `UPDATE _continuum_migration_execution SET state='completed',
           executed_sql_sha256=$2,statement_count=$3,completed_at=clock_timestamp()
         WHERE attempt_id=$1 AND state='started'`,
        [this.attemptId, digest, this.statementCount],
      );
      if (updated.rowCount !== 1) throw new Error('Migration execution attempt was not pending');
    } else {
      await client.query(
        `INSERT INTO _continuum_migration_execution
          (attempt_id,migration_name,phase,variant,source_sha256,effective_sql_sha256,
           dependency_source_sha256,state,executed_sql_sha256,statement_count,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,clock_timestamp())`,
        [this.attemptId, this.name, this.phase, this.variant, this.sourceHash,
          this.effectiveHash, this.dependencyHash, digest, this.statementCount],
      );
    }
  }
}

/** Bootstrap alongside the old ledger, before special early upgrade phases. */
export async function ensureExecutionLedger(client: pg.PoolClient): Promise<boolean> {
  const previous = await client.query<{ exists: boolean }>(
    `SELECT to_regclass(format('%I._continuum_migration_execution',current_schema()))
      IS NOT NULL AS exists`,
  );
  const created = previous.rows[0]?.exists !== true;
  try {
    await client.query('BEGIN');
    await client.query(`
      DO $trust$
      DECLARE schema_owner OID;
      BEGIN
        SELECT nspowner INTO schema_owner FROM pg_namespace WHERE nspname=current_schema();
        IF schema_owner IS NULL OR NOT (
          schema_owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_has_role(current_user,schema_owner,'USAGE')
          OR (schema_owner='pg_database_owner'::regrole AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)=
            (SELECT datdba FROM pg_database WHERE datname=current_database()))) THEN
          RAISE EXCEPTION 'migration provenance requires the owner-controlled application schema';
        END IF;
        IF EXISTS(SELECT 1 FROM pg_namespace namespace
          CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl,acldefault('n',namespace.nspowner))) privilege
          WHERE namespace.nspname=current_schema() AND privilege.privilege_type='CREATE'
            AND privilege.grantee<>namespace.nspowner) THEN
          RAISE EXCEPTION 'migration provenance application schema has untrusted CREATE grants; revoke CREATE as the schema owner before retrying';
        END IF;
        IF EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(format('%I._continuum_migration_execution',current_schema()))
          AND (relkind<>'r' OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))) THEN
          RAISE EXCEPTION 'migration provenance relation ownership or kind drift';
        END IF;
      END $trust$;
      CREATE TABLE IF NOT EXISTS _continuum_migration_execution (
        attempt_id UUID PRIMARY KEY,
        migration_name TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('file','file-online','pre-0065-stored-crlf',
          'pre-0075-candidate-reinstall','contract-backfill','legacy-history')),
        variant TEXT NOT NULL CHECK(length(variant) BETWEEN 1 AND 100),
        source_sha256 TEXT CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
        effective_sql_sha256 TEXT CHECK(effective_sql_sha256 ~ '^[0-9a-f]{64}$'),
        dependency_source_sha256 TEXT CHECK(dependency_source_sha256 ~ '^[0-9a-f]{64}$'),
        executed_sql_sha256 TEXT CHECK(executed_sql_sha256 ~ '^[0-9a-f]{64}$'),
        statement_count INTEGER CHECK(statement_count>=0),
        state TEXT NOT NULL CHECK(state IN ('started','completed','history-unknown')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        completed_at TIMESTAMPTZ,
        CHECK ((state='completed' AND effective_sql_sha256 IS NOT NULL
          AND executed_sql_sha256 IS NOT NULL AND statement_count IS NOT NULL AND completed_at IS NOT NULL)
          OR (state<>'completed' AND executed_sql_sha256 IS NULL AND statement_count IS NULL AND completed_at IS NULL)),
        CHECK(state<>'history-unknown' OR (source_sha256 IS NULL AND effective_sql_sha256 IS NULL
          AND dependency_source_sha256 IS NULL AND phase='legacy-history'))
      );
    `);
    if (created) {
      // Default ACLs must not turn bookkeeping into an application capability.
      await client.query(`DO $defaults$
        DECLARE grant_row RECORD;
        BEGIN
          FOR grant_row IN SELECT DISTINCT privilege.grantee FROM pg_class relation
            CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
            WHERE relation.oid='_continuum_migration_execution'::regclass AND privilege.grantee<>relation.relowner LOOP
            IF grant_row.grantee=0 THEN REVOKE ALL ON _continuum_migration_execution FROM PUBLIC;
            ELSE EXECUTE format('REVOKE ALL ON _continuum_migration_execution FROM %I',
              pg_get_userbyid(grant_row.grantee)); END IF;
          END LOOP;
        END $defaults$;`);
    }
    await client.query(`DO $shape$
      DECLARE actual TEXT[];
      BEGIN
        SELECT array_agg(attname||':'||format_type(atttypid,atttypmod) ORDER BY attname)
        INTO actual FROM pg_attribute WHERE attrelid='_continuum_migration_execution'::regclass
          AND attnum>0 AND NOT attisdropped;
        IF actual IS DISTINCT FROM ARRAY[
          'attempt_id:uuid','completed_at:timestamp with time zone','dependency_source_sha256:text',
          'effective_sql_sha256:text','executed_sql_sha256:text','migration_name:text','phase:text',
          'source_sha256:text','started_at:timestamp with time zone','state:text','statement_count:integer','variant:text'] THEN
          RAISE EXCEPTION 'migration provenance column shape drift';
        END IF;
        IF EXISTS(SELECT 1 FROM pg_class relation
          CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
          WHERE relation.oid='_continuum_migration_execution'::regclass AND privilege.grantee<>relation.relowner)
          OR EXISTS(SELECT 1 FROM pg_attribute attribute JOIN pg_class relation ON relation.oid=attribute.attrelid
            CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
            WHERE relation.oid='_continuum_migration_execution'::regclass AND privilege.grantee<>relation.relowner) THEN
          RAISE EXCEPTION 'migration provenance privilege drift';
        END IF;
      END $shape$;
      CREATE INDEX IF NOT EXISTS continuum_migration_execution_phase_idx
        ON _continuum_migration_execution(migration_name,phase);
    `);
    await client.query('COMMIT');
  } catch (error) {
    await rollbackExecutionTransaction(client, error);
  }
  return created;
}

export async function recordUnknownHistory(client: pg.PoolClient, name: string): Promise<void> {
  await client.query(
    `INSERT INTO _continuum_migration_execution(attempt_id,migration_name,phase,variant,state)
     SELECT $1,$2,'legacy-history','history-unknown','history-unknown'
     WHERE NOT EXISTS(SELECT 1 FROM _continuum_migration_execution
       WHERE migration_name=$2 AND (phase='legacy-history' OR
         (phase IN ('file','file-online') AND state='completed')))`,
    [randomUUID(), name],
  );
}

/** Final directly defined contract functions, checked against verified source. */
export async function verifyContractFunctionBodies(client: pg.PoolClient, source: string): Promise<void> {
  for (const [name, args] of [
    ['continuum_coordination_require_contract_ready', ''],
    ['continuum_backfill_coordination_contract', 'integer'],
  ]) {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    const bodyStart = source.indexOf('AS $$', start);
    const bodyEnd = source.indexOf('$$;', bodyStart + 5);
    if (start<0 || bodyStart<0 || bodyEnd<0) throw new Error(`Missing verified contract body for ${name}`);
    const expected = source.slice(bodyStart + 5, bodyEnd);
    const result = await client.query<{
      prosrc: string; owner: boolean; language: string; prosecdef: boolean;
      hardened: boolean; publicExecute: boolean;
    }>(`SELECT function.prosrc,function.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owner,
        language.lanname AS language,function.prosecdef,
        function.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',current_schema())] AS hardened,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(function.proacl,acldefault('f',function.proowner))) privilege
          WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE') AS "publicExecute"
      FROM pg_proc function JOIN pg_language language ON language.oid=function.prolang
      WHERE function.oid=to_regprocedure(format('%I.%s(%s)',current_schema(),$1::text,$2::text))`, [name,args]);
    const row = result.rows[0];
    if (!row || sqlHash(row.prosrc) !== sqlHash(expected) || !row.owner || row.language !== 'plpgsql'
      || !row.prosecdef || !row.hardened || row.publicExecute) {
      throw new Error(`Current coordination contract function body or trust drift: ${name}(${args})`);
    }
  }
}
