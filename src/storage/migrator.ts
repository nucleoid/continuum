import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import {
  ensureExecutionLedger, executionClientIsUnsafe, MigrationExecution, recordUnknownHistory,
  rollbackExecutionTransaction, sqlHash, verifyContractFunctionBodies,
} from './migration-execution.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, '../../migrations');
const DEFAULT_VECTOR_PROVIDER_SCHEMA = 'continuum_extensions';
const LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN =
  'CONTINUUM_ALLOW_LEGACY_SHARED_VECTOR_SCHEMA';

// This key coordinates every Continuum migrator connected to the same database.
// Changing it would break coordination with replicas running an older version.
const CONTINUUM_MIGRATION_LOCK_ID = '7215328273579717613';
const NO_TRANSACTION_MARKER = '-- continuum:no-transaction';
const REPAIR_INVALID_INDEX = '-- continuum:repair-invalid-index ';
const REQUIRE_VALID_INDEX = '-- continuum:require-valid-index ';
const BACKFILL_OFFBOARDING_SELECTORS = '-- continuum:backfill-offboarding-selectors';
const BACKFILL_COORDINATION_REPAIR = '-- continuum:backfill-coordination-repair';
const BACKFILL_COORDINATION_V4 = '-- continuum:backfill-coordination-v4';
const BACKFILL_COORDINATION_V5 = '-- continuum:backfill-coordination-v5';
const BACKFILL_COORDINATION_CONTRACT = '-- continuum:backfill-coordination-contract';
const COORDINATION_V4_BACKFILL_BATCH_ENV =
  'CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE';
const PUBLISHED_MIGRATION_CHECKSUMS = new Map([
  ['0052_offboarding_review_repair.sql',
    '136cbd834277ca4fbfb48162644738ba2f96f7a5705290cc0c585e3ce7c82079'],
  ['0053_offboarding_restore_contract.sql',
    'f773ea0bb4aba1005690b320a71a4aaa0c798484d950057d92c5a68bd4e33900'],
  ['0054_coordination_leases.sql',
    'c69b96b7e8f64ce9d64da71b5026a2e8896cdcf6efb7a52107ca6ab062e7619a'],
  ['0055_coordination_review_remediation.sql',
    '478d40c2367f3fa900984767e18110fe5aa377aadcda1387225dc5dea87176fd'],
  ['0056_coordination_final_remediation.sql',
    '034df4cf096603fc895247f05246ca442b604d0df7dc05596e4c7b43af683c27'],
  ['0057_coordination_privacy_race_remediation.sql',
    '7e8d0bbc1f733d76a55c5d9835280880f4254d951d7db41351b4b4ed01d8b3e3'],
  ['0058_coordination_online_prep.sql',
    '56850725814e6385e1c3c5253aeecce6060f2feafe96003de7f19861ede550bf'],
  ['0059_coordination_bounded_privacy.sql',
    '5973bed68dd895df4d49e8603a72e232d696625eff815a89cb00365d7bf35d25'],
  ['0060_coordination_online_finish.sql',
    '97d3c881c44f950a7264ca93b5d0abb0f07a2ee26df14f07316dbbd7190048a7'],
  ['0061_coordination_forward_security_repair.sql',
    'b8cf3529afd40b40ca1b05262bb5425a76cd1def64078cb83ceacbd2b4a4692f'],
  ['0062_coordination_forward_online_finish.sql',
    '8b6de993de4b3e571461368e48ee184eee2be3276bb6091d45f17e2e600fc77f'],
  ['0063_coordination_final_privacy_repair.sql',
    '4e6c13b689cd1ba6d14c37aa58701d6e430c890cdd6dd97aedb5c6c1c5292716'],
  ['0064_coordination_final_online_indexes.sql',
    '4c7ba440652d6fabf94017140e6b7d240f157ba109984438a31dc0ca14ad2109'],
  ['0065_coordination_review_remediation.sql',
    '7b7d0ab26646f7770c8ab93899b6698a39872fc149af3d39e0c869547f0d5030'],
  ['0066_coordination_upgrade_privacy_repair.sql',
    '48223c50b0e39434446f6bebd7d625e51786b4606a70dadce44832b6b65d8bb2'],
  ['0067_coordination_rollout_repair.sql',
    '8f868cbe1bbe19684c0857ef8b110fb55d2565059b3862f1f1585ba893d53fe3'],
  ['0068_coordination_production_repair.sql',
    'b9488db55b8392f9a2d7eb4061dd190e69f3fba9ae230ca8ecee9696706ce390'],
  ['0069_coordination_independent_review.sql',
    '77847f54221ddc24ca5dc2d1ba43efce19e0c2beb4c599147a23621cb54de9bf'],
  ['0070_coordination_linkable_audit_index.sql',
    'f234e2e1a564a7216fb4ae79e042f7c6d41540cccc2a9304267fc8cfd022cf97'],
  ['0071_coordination_review_completion.sql',
    '16b4784899e6467c57032b332cc56660c4cfd3c3492296f640f2f232b7de1670'],
  ['0072_coordination_final_review_remediation.sql',
    '9e763a73e16e16ed8b37c9d7c6654f56f62ae96ef62eb9b004ad2b325cd1d4a9'],
  ['0073_coordination_bounded_discovery_and_locking.sql',
    'b2f96e35511e563cc9890d871d3910d70a3d99856e233f4da9b151405ef72e7b'],
  ['0074_coordination_compatibility_and_upgrade_repair.sql',
    'e3b743394f640ef2db5daeb8596793066a6c4f5c1a6222c50d1b9daff95fbd66'],
  ['0075_coordination_online_repair_finish.sql',
    'd1d69f661803f7546ca23234a6babb96a104ad098d4c48e3388ab30bf7d5d9cf'],
  ['0076_coordination_review_2_remediation.sql',
    '5a1320f5890a4c99d53d83baabd54ee7025e4a4963227f95f4b2806071839623'],
  ['0077_coordination_review_2_online_finish.sql',
    '1eef4ffacc6ddd36e0c34c4029a06b766a8f2dd6a12f1018217904e334b7637d'],
  ['0078_coordination_upgrade_scale_indexes.sql',
    '39d21c91e36bb67698c593a6d9929982c0f3138eee6575e4008a929c6853a120'],
  ['0079_coordination_upgrade_scale_remediation.sql',
    '147497bac862bfc7f25123cd3f655550c2c6c4c574a3519fa2a98dd62828d85a'],
  ['0080_pgvector_provider_grants.sql',
    '4bf24d99ee26c266d7738e797d7cb4c0078560e09669c9e9d07232496d671c5b'],
  ['0081_coordination_public_contract.sql',
    'f702dcb46f7d673d45ed96852d236619192ab43b9b57617e3595cad2975c4982'],
  ['0083_tag_vocabularies.sql',
    '6d7dfb4e612b699f40837698da3156166330eda3e003f67fd59f602554936d91'],
  ['0084_provider_embeddings_backfill.sql',
    '68e754cb35f98d637879bcb9519f3603ec6e118a7f6945c6bef4fc86e8a7ada3'],
  ['0085_embedding_backfill_failures.sql',
    'bf832c89bffcb3d03e33a006601f9044907779465c6e860d9db42b282d68a14d'],
  ['0086_embedding_backfill_failure_disposition.sql',
    '470c7a9458fedb3834987cc7a276e3ffacc2f893a39e936cea0f8a88d8687539'],
  ['0087_embedding_provider_scan_index.sql',
    'f9ab8aacaa5bd70bb251bea6a0323a4002dd370949e743b149687301095fc204'],
  ['0088_embedding_provider_scan_index_rebuild.sql',
    'e0f21f1cfa4a81fbc7c8fbe65e06ae31157e499dbf562b482b87099185e079e2'],
  ['0089_promotion_outbox.sql', '034fff0c1f04c67d5b9e6e5bab5500e7c0b93b4b9baef5351c8e095fef7dc6ff'],
  ['0090_standup_activity.sql', 'ddf1f0bb884df857f7b17eb9d9b91da2fa527561990fc96604b43af7af8f657e'],
]);
const FORWARD_MIGRATION_REQUIREMENTS = new Map([
  ['0084_provider_embeddings_backfill.sql', '0083_tag_vocabularies.sql'],
  ['0085_embedding_backfill_failures.sql', '0084_provider_embeddings_backfill.sql'],
  ['0086_embedding_backfill_failure_disposition.sql', '0085_embedding_backfill_failures.sql'],
  ['0087_embedding_provider_scan_index.sql', '0086_embedding_backfill_failure_disposition.sql'],
  ['0088_embedding_provider_scan_index_rebuild.sql', '0087_embedding_provider_scan_index.sql'],
  ['0089_promotion_outbox.sql', '0088_embedding_provider_scan_index_rebuild.sql'],
  ['0090_standup_activity.sql', '0089_promotion_outbox.sql'],
  ['0053_offboarding_restore_contract.sql', '0052_offboarding_review_repair.sql'],
  ['0056_coordination_final_remediation.sql', '0055_coordination_review_remediation.sql'],
  ['0057_coordination_privacy_race_remediation.sql',
    '0056_coordination_final_remediation.sql'],
  ['0058_coordination_online_prep.sql',
    '0057_coordination_privacy_race_remediation.sql'],
  ['0059_coordination_bounded_privacy.sql',
    '0058_coordination_online_prep.sql'],
  ['0060_coordination_online_finish.sql',
    '0059_coordination_bounded_privacy.sql'],
  ['0061_coordination_forward_security_repair.sql',
    '0060_coordination_online_finish.sql'],
  ['0062_coordination_forward_online_finish.sql',
    '0061_coordination_forward_security_repair.sql'],
  ['0063_coordination_final_privacy_repair.sql',
    '0062_coordination_forward_online_finish.sql'],
  ['0064_coordination_final_online_indexes.sql',
    '0063_coordination_final_privacy_repair.sql'],
  ['0065_coordination_review_remediation.sql',
    '0064_coordination_final_online_indexes.sql'],
  ['0066_coordination_upgrade_privacy_repair.sql',
    '0065_coordination_review_remediation.sql'],
  ['0067_coordination_rollout_repair.sql',
    '0066_coordination_upgrade_privacy_repair.sql'],
  ['0068_coordination_production_repair.sql',
    '0067_coordination_rollout_repair.sql'],
  ['0069_coordination_independent_review.sql',
    '0068_coordination_production_repair.sql'],
  ['0070_coordination_linkable_audit_index.sql',
    '0069_coordination_independent_review.sql'],
  ['0071_coordination_review_completion.sql',
    '0070_coordination_linkable_audit_index.sql'],
  ['0072_coordination_final_review_remediation.sql',
    '0071_coordination_review_completion.sql'],
  ['0073_coordination_bounded_discovery_and_locking.sql',
    '0072_coordination_final_review_remediation.sql'],
  ['0074_coordination_compatibility_and_upgrade_repair.sql',
    '0073_coordination_bounded_discovery_and_locking.sql'],
  ['0075_coordination_online_repair_finish.sql',
    '0074_coordination_compatibility_and_upgrade_repair.sql'],
  ['0076_coordination_review_2_remediation.sql',
    '0075_coordination_online_repair_finish.sql'],
  ['0077_coordination_review_2_online_finish.sql',
    '0076_coordination_review_2_remediation.sql'],
  ['0078_coordination_upgrade_scale_indexes.sql',
    '0077_coordination_review_2_online_finish.sql'],
  ['0079_coordination_upgrade_scale_remediation.sql',
    '0078_coordination_upgrade_scale_indexes.sql'],
  ['0080_pgvector_provider_grants.sql',
    '0079_coordination_upgrade_scale_remediation.sql'],
  ['0081_coordination_public_contract.sql',
    '0080_pgvector_provider_grants.sql'],
  ['0083_tag_vocabularies.sql',
    '0082_coordination_linkable_audit_v7_index.sql'],
]);
const REVIEW_ENTRA_MIGRATION_RENAMES = [
  ['0005_entra_auth.sql', '0010_entra_auth.sql'],
  ['0006_entra_binding_approval.sql', '0011_entra_binding_approval.sql'],
  ['0007_entra_binding_revocation.sql', '0012_entra_binding_revocation.sql'],
  ['0008_entra_binding_membership_invariant.sql', '0013_entra_binding_membership_invariant.sql'],
  ['0009_lock_entra_binding_invariant.sql', '0014_lock_entra_binding_invariant.sql'],
  ['0010_harden_entra_binding_invariants.sql', '0015_harden_entra_binding_invariants.sql'],
  ['0011_canonicalize_entra_ids.sql', '0016_canonicalize_entra_ids.sql'],
  ['0012_entra_quarantine_state.sql', '0017_entra_quarantine_state.sql'],
  ['0013_canonicalize_principal_external_ids.sql', '0018_canonicalize_principal_external_ids.sql'],
  ['0014_entra_sync_freshness.sql', '0019_entra_sync_freshness.sql'],
  ['0015_entra_review_hardening.sql', '0020_entra_review_hardening.sql'],
] as const;

function publishedMigrationChecksum(bytes: Buffer): string {
  const checksum = createHash('sha256');
  let chunkStart = 0;

  // Git may materialize tracked text as CRLF on Windows. Canonicalize only
  // that byte pair so the published LF checksum remains authoritative while
  // lone CR bytes and every substantive byte continue to be tamper-evident.
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      checksum.update(bytes.subarray(chunkStart, index));
      chunkStart = index + 1;
    }
  }
  return checksum.update(bytes.subarray(chunkStart)).digest('hex');
}

function firstSearchPathIdentifier(searchPath: string): string | undefined {
  let index = 0;
  while (index < searchPath.length && /\s/.test(searchPath[index]!)) index += 1;
  if (index >= searchPath.length) return undefined;
  if (searchPath[index] === '"') {
    let value = '';
    index += 1;
    while (index < searchPath.length) {
      if (searchPath[index] !== '"') {
        value += searchPath[index];
        index += 1;
      } else if (searchPath[index + 1] === '"') {
        value += '"';
        index += 2;
      } else {
        index += 1;
        while (index < searchPath.length && /\s/.test(searchPath[index]!)) index += 1;
        if (index < searchPath.length && searchPath[index] !== ',') return undefined;
        return value || undefined;
      }
    }
    return undefined;
  }
  const comma = searchPath.indexOf(',', index);
  const value = searchPath.slice(index, comma < 0 ? undefined : comma).trim();
  if (value === '$user') return value;
  if (!value || !/^[a-z_][a-z0-9_$]*$/.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

async function verifyPublishedMigration(
  migrationsDir: string, file: string,
): Promise<string> {
  const bytes = await readFile(join(migrationsDir, file));
  const source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  const publishedChecksum = PUBLISHED_MIGRATION_CHECKSUMS.get(file);
  if (!publishedChecksum) return source;
  const actualChecksum = publishedMigrationChecksum(bytes);
  if (actualChecksum !== publishedChecksum) {
    throw new Error(
      `Published migration ${file} was modified after publication: `
      + `expected checksum ${publishedChecksum}, received ${actualChecksum}`,
    );
  }
  return source;
}

function deferLegacy0073Backfill(sql: string): string {
  const startMarker = '-- One-time backfill starts from the three dirty indexes';
  const endMarker = 'CREATE OR REPLACE FUNCTION continuum_coordination_privacy_repair_candidates';
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error('published 0073 online-backfill boundary was not found');
  }
  return `${sql.slice(0, start)}-- Backfill deferred to online migration 0075.\n\n${sql.slice(end)}`;
}

function repair0074PartialUpgradeDiscovery(sql: string): string {
  const replacements = [
    [
      'WHERE progress.repair_eligible IS TRUE',
      `WHERE (COALESCE(progress.repair_eligible, principal.disabled_at IS NOT NULL)
            OR (progress.repair_eligible IS FALSE
                AND principal.disabled_at IS NOT NULL))`,
    ],
    [
      'AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)',
      `AND progress.principal_id >= COALESCE(
         after_principal_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (after_principal_id IS NULL OR progress.principal_id > after_principal_id)`,
    ],
    [
      'WHERE (after_principal_id IS NULL OR marker.principal_id > after_principal_id)',
      `WHERE marker.principal_id >= COALESCE(
         after_principal_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (after_principal_id IS NULL OR marker.principal_id > after_principal_id)`,
    ],
    [
      `WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND position(chr(13) IN function.prosrc) > 0`,
      `WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname LIKE 'continuum\\_%' ESCAPE '\\'
       AND function.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
       AND position(chr(13) || chr(10) IN function.prosrc) > 0
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = function.oid
            AND dependency.refclassid = 'pg_extension'::regclass
            AND dependency.deptype = 'e')`,
    ],
    [
      `    normalized := replace(replace(definition, chr(13) || chr(10), chr(10)), chr(13), chr(10));`,
      `    normalized := replace(definition, chr(13) || chr(10), chr(10));`,
    ],
  ] as const;
  let repaired = sql;
  for (const [before, after] of replacements) {
    if (!repaired.includes(before)) {
      throw new Error('published 0074 partial-upgrade discovery boundary was not found');
    }
    repaired = repaired.replace(before, after);
  }
  return repaired;
}

function repaired0074CandidateFunction(sql: string): string {
  const repaired = repair0074PartialUpgradeDiscovery(sql);
  const start = repaired.indexOf(
    'CREATE OR REPLACE FUNCTION continuum_coordination_privacy_repair_candidates',
  );
  const end = repaired.indexOf(
    'CREATE OR REPLACE FUNCTION continuum_operator_scrub_coordination_principal', start,
  );
  if (start < 0 || end < 0) {
    throw new Error('published 0074 candidate-function boundary was not found');
  }
  return `${repaired.slice(start, end)}
DO $harden_partial_0074$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_coordination_privacy_repair_candidates(uuid,uuid,integer) '
    || 'SET search_path = pg_catalog, %I, pg_temp', schema_name, schema_name);
END;
$harden_partial_0074$;`;
}

function repair0076CrLfNormalization(sql: string): string {
  const before = String.raw`       AND position(chr(13) IN function.prosrc) > 0`;
  const after = String.raw`       AND position(chr(13) || chr(10) IN function.prosrc) > 0`;
  const normalizationBefore =
    `    normalized := replace(replace(definition, chr(13) || chr(10), chr(10)), `
    + `chr(13), chr(10));`;
  const normalizationAfter =
    `    normalized := replace(definition, chr(13) || chr(10), chr(10));`;
  if (!sql.includes(before) || !sql.includes(normalizationBefore)) {
    throw new Error('published 0076 CRLF normalization boundary was not found');
  }
  return sql.replace(before, after).replace(normalizationBefore, normalizationAfter);
}

async function repairStoredCrLfFunctions(
  client: pg.PoolClient, execution: MigrationExecution,
): Promise<void> {
  const functions = await client.query<{ definition: string }>(
    String.raw`SELECT pg_get_functiondef(function.oid) AS definition
       FROM pg_proc function
      WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
        AND function.proname LIKE 'continuum\_%' ESCAPE '\'
        AND function.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        AND position(chr(13) || chr(10) IN function.prosrc) > 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend dependency
           WHERE dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = function.oid
             AND dependency.refclassid = 'pg_extension'::regclass
             AND dependency.deptype = 'e')
      ORDER BY function.oid`,
  );
  for (const row of functions.rows) {
    const normalized = row.definition.replaceAll('\r\n', '\n');
    await execution.query(client, normalized);
  }
  const remaining = await client.query<{ count: number }>(
    String.raw`SELECT count(*)::int AS count
       FROM pg_proc function
      WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
        AND function.proname LIKE 'continuum\_%' ESCAPE '\'
        AND function.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        AND position(chr(13) || chr(10) IN function.prosrc) > 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend dependency
           WHERE dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = function.oid
             AND dependency.refclassid = 'pg_extension'::regclass
             AND dependency.deptype = 'e')`,
  );
  if (remaining.rows[0]?.count !== 0) {
    throw new Error('stored CRLF function-body repair did not converge');
  }
}

function coordinationBackfillBatchSize(): number {
  const configured = process.env[COORDINATION_V4_BACKFILL_BATCH_ENV];
  if (configured === undefined || configured === '') return 1000;
  const batchSize = Number(configured);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error(`${COORDINATION_V4_BACKFILL_BATCH_ENV} must be an integer from 1 to 5000`);
  }
  return batchSize;
}

async function runAdaptiveCoordinationBackfill(
  client: pg.PoolClient, functionName: string, execution: MigrationExecution,
  maximumBatchSize = 5000,
): Promise<void> {
  let batchSize = Math.min(coordinationBackfillBatchSize(), maximumBatchSize);
  await client.query("SET lock_timeout = '1s'");
  await client.query("SET statement_timeout = '5s'");
  try {
    const cleanup = functionName === 'continuum_backfill_coordination_cleanup';
    const cleanupProgress = async () => {
      const result = await execution.query<{ rows_processed: string; last_lease_id: string | null }>(client,
        `SELECT rows_processed::text,pg_catalog.to_jsonb(progress)->>'last_lease_id' AS last_lease_id
         FROM coordination_migration_progress progress
         WHERE name='issue7-cleanup-eligibility'`,
      );
      return { rows: result.rows[0]?.rows_processed ?? '0', cursor: result.rows[0]?.last_lease_id ?? null };
    };
    let previous = cleanup ? await cleanupProgress() : undefined;
    for (;;) {
      try {
        const result = await execution.query<{ completed: boolean }>(client,
          `SELECT ${functionName}($1) AS completed`, [batchSize],
        );
        if (result.rows[0]?.completed === true) return;
        if (cleanup) {
          const next = await cleanupProgress();
          if (previous?.rows === next.rows && previous.cursor === next.cursor) {
            // SKIP LOCKED can return FALSE repeatedly without advancing. A
            // bounded plain lock probe turns persistent contention into 55P03;
            // successful batches have no arbitrary iteration limit.
            await execution.query(client,
              `SELECT lease.lease_id FROM coordination_leases lease
               WHERE lease.cleanup_eligible_at IS NULL AND NOT EXISTS(
                 SELECT 1 FROM coordination_resources resource WHERE resource.current_lease_id=lease.lease_id)
               ORDER BY lease.lease_id LIMIT 1 FOR UPDATE`,
            );
          }
          previous = next;
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if ((code !== '55P03' && code !== '57014') || batchSize === 1) throw error;
        batchSize = Math.max(1, Math.floor(batchSize / 2));
      }
    }
  } finally {
    await client.query('RESET statement_timeout');
    await client.query('RESET lock_timeout');
  }
}

function nonTransactionalStatements(sql: string): string[] {
  const body = sql.trimStart().slice(NO_TRANSACTION_MARKER.length).trim();
  const statements = body
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error('no-transaction migration must contain at least one statement');
  }
  return statements;
}

function directiveIndexName(statement: string, directive: string): string | null {
  const line = statement.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(directive));
  if (!line) return null;
  const name = line.trim().slice(directive.length).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid no-transaction index directive: ${statement}`);
  }
  return name;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function indexState(
  client: pg.PoolClient, indexName: string,
): Promise<{ schema: string; valid: boolean } | null> {
  const result = await client.query(
    `SELECT n.nspname AS schema, i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass(format('%I.%I', current_schema(), $1::text))`,
    [indexName],
  );
  return result.rows[0] ?? null;
}

async function runNonTransactionalStatement(
  client: pg.PoolClient, statement: string,
  execution: MigrationExecution,
  deferCoordinationBackfill = false,
): Promise<void> {
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_COORDINATION_V4,
  )) {
    await runAdaptiveCoordinationBackfill(client, 'continuum_backfill_coordination_v4', execution);
    return;
  }
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_COORDINATION_V5,
  )) {
    await runAdaptiveCoordinationBackfill(client, 'continuum_backfill_coordination_v5', execution);
    return;
  }
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_COORDINATION_REPAIR,
  )) {
    if (deferCoordinationBackfill) return;
    await runAdaptiveCoordinationBackfill(client, 'continuum_backfill_coordination_cleanup', execution, 1000);
    return;
  }
  if (statement.split(/\r?\n/).some(
    (line) => line.trim() === BACKFILL_OFFBOARDING_SELECTORS,
  )) {
    const available = await client.query<{ available: boolean }>(
      `SELECT to_regprocedure(format(
         '%I.continuum_backfill_audit_offboarding_scopes(integer)', current_schema()
       )) IS NOT NULL AS available`,
    );
    // Review-era 0033 installations did not create the bounded backfill
    // function. 0036 installs it and 0037 invokes this same directive, so 0035
    // must finish its retry-safe indexes without resolving another schema's
    // function or failing before the compatibility migration can run.
    if (available.rows[0]?.available !== true) return;
    await client.query("SET statement_timeout = '30s'");
    try {
      for (;;) {
        const result = await execution.query<{ completed: boolean }>(client,
          `SELECT continuum_backfill_audit_offboarding_scopes(1000) AS completed`,
        );
        if (result.rows[0]?.completed === true) return;
      }
    } finally {
      await client.query('RESET statement_timeout');
    }
  }
  const repairName = directiveIndexName(statement, REPAIR_INVALID_INDEX);
  if (repairName) {
    const state = await indexState(client, repairName);
    if (state && !state.valid) {
      await execution.query(client,
        `DROP INDEX CONCURRENTLY ${quoteIdentifier(state.schema)}.${quoteIdentifier(repairName)}`,
      );
    }
    return;
  }
  const requiredName = directiveIndexName(statement, REQUIRE_VALID_INDEX);
  if (requiredName) {
    const state = await indexState(client, requiredName);
    if (!state?.valid) {
      throw new Error(`required index ${requiredName} is missing or invalid in current schema`);
    }
    return;
  }
  await execution.query(client, statement);
}

async function finishContractBackfill(
  client: pg.PoolClient, file: string, source: string,
): Promise<void> {
  const execution = new MigrationExecution(file, 'contract-backfill',
    'coordination-contract-adaptive-1000-v1', sqlHash(source),
    sqlHash('continuum_backfill_coordination_contract(integer); max=1000; lock=1s; statement=5s; adaptive-v1'));
  if (file === '0081_coordination_public_contract.sql') {
    await verifyContractFunctionBodies(client, source);
  }
  await client.query(`DO $contract_owner$
    DECLARE target OID;
    BEGIN
      target := to_regprocedure(format('%I.continuum_backfill_coordination_contract(integer)',current_schema()));
      IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN
        RAISE EXCEPTION 'coordination contract backfill requires its function owner';
      END IF;
    END $contract_owner$;`);
  if (await execution.hasCompleted(client)) {
    const state = await client.query<{ completed: boolean }>(
      `SELECT phase='complete' AS completed FROM coordination_contract_backfill_state WHERE singleton`,
    );
    if (state.rows[0]?.completed === true) return;
  }
  await execution.start(client);
  await runAdaptiveCoordinationBackfill(client, 'continuum_backfill_coordination_contract', execution, 1000);
  if (file === '0081_coordination_public_contract.sql') {
    await verifyContractFunctionBodies(client, source);
  }
  try {
    await client.query('BEGIN');
    await execution.complete(client, true);
    await client.query('COMMIT');
  } catch (error) {
    await rollbackExecutionTransaction(client, error);
  }
}

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<AppliedMigration[]> {
  const client = await pool.connect();
  const applied: AppliedMigration[] = [];
  let lockAcquired = false;
  let runFailed = false;
  let runError: unknown;
  let originalSearchPath: string | undefined;
  let callerSearchPath: string | undefined;
  let applicationSchema: string | undefined;
  let migrationLedgerCreated = false;
  let executionLedgerCreated = false;
  let discardClient = false;
  let providerSchemaCreated = false;
  let vectorExtensionCreated = false;

  const restoreInitialMigrationSearchPath = async (): Promise<void> => {
    if (originalSearchPath === undefined) return;
    const path = originalSearchPath;
    await client.query(
      `SELECT pg_catalog.set_config('search_path', $1, FALSE)`,
      [path],
    );
    originalSearchPath = undefined;
  };

  try {
    // A session blocked inside pg_advisory_lock owns a virtual transaction.
    // CREATE INDEX CONCURRENTLY in the lock holder must wait for that virtual
    // transaction, producing a lock cycle. Poll without retaining a snapshot.
    while (!lockAcquired) {
      const lockResult = await client.query<{ locked: boolean }>(
        'SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS locked',
        [CONTINUUM_MIGRATION_LOCK_ID],
      );
      lockAcquired = lockResult.rows[0]?.locked === true;
      if (!lockAcquired) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Verify every pinned file before consulting or creating the ledger. A modified
    // pending migration must never get an opportunity to execute.
    const verifiedSources = new Map<string, string>();
    for (const file of files) {
      verifiedSources.set(file, await verifyPublishedMigration(migrationsDir, file));
    }

    let ledgerAlreadyExisted = false;
    if (files.includes('0001_init.sql')) {
      const pathState = await client.query<{
        path: string;
        schema: string | null;
        currentUser: string;
        owned: boolean;
        unsafeCreate: boolean;
        userSchemaExists: boolean;
      }>(`
        SELECT pg_catalog.current_setting('search_path') AS path,
               namespace.nspname AS schema,
               current_user AS "currentUser",
               COALESCE(
                 namespace.nspowner = role.oid
                   OR (namespace.nspowner = 'pg_database_owner'::pg_catalog.regrole
                       AND role.oid = (
                         SELECT database.datdba FROM pg_catalog.pg_database database
                          WHERE database.datname = pg_catalog.current_database()))
                   OR (NOT role.rolsuper
                       AND pg_catalog.pg_has_role(role.oid, namespace.nspowner, 'USAGE')),
                 FALSE
               ) AS owned,
               COALESCE(EXISTS (
                 SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     namespace.nspacl,
                     pg_catalog.acldefault('n', namespace.nspowner))) privilege
                  WHERE pg_catalog.upper(privilege.privilege_type) = 'CREATE'
                    AND privilege.grantee <> namespace.nspowner
               ), FALSE) AS "unsafeCreate",
               pg_catalog.to_regnamespace(current_user) IS NOT NULL AS "userSchemaExists"
          FROM pg_catalog.pg_roles role
          LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.nspname = pg_catalog.current_schema()
         WHERE role.rolname = current_user
      `);
      applicationSchema = pathState.rows[0]?.schema ?? undefined;
      const firstPathSchema = firstSearchPathIdentifier(pathState.rows[0]?.path ?? '');
      const resolvedFirstPathSchema = firstPathSchema === '$user'
        ? (pathState.rows[0]?.userSchemaExists === true
            ? pathState.rows[0]?.currentUser
            : applicationSchema)
        : firstPathSchema;
      if (!applicationSchema
          || resolvedFirstPathSchema !== applicationSchema) {
        throw new Error(
          'The migration search_path first entry must name an existing application schema; '
          + 'empty, planted, or malformed leading entries are not allowed',
        );
      }
      if (!pathState.rows[0]?.owned) {
        throw new Error(
          `The application schema ${quoteIdentifier(applicationSchema)} selected by `
          + `search_path must be owner-controlled by the current migration role`,
        );
      }
      const ledgerState = await client.query<{ exists: boolean }>(
        `SELECT pg_catalog.to_regclass(pg_catalog.format('%I._continuum_migrations', $1::text)) IS NOT NULL AS exists`,
        [applicationSchema],
      );
      ledgerAlreadyExisted = ledgerState.rows[0]?.exists === true;
      if (pathState.rows[0]?.unsafeCreate) {
        throw new Error(
          `The application schema ${quoteIdentifier(applicationSchema)} selected by `
          + `search_path must not grant CREATE to PUBLIC or a non-owner. `
          + 'Revoke CREATE as the application schema owner before retrying',
        );
      }

      // Caller suffixes must never resolve ordinary migration functions or
      // types. Keep the validated provider overlay limited to 0001 below.
      callerSearchPath = pathState.rows[0]?.path;
      await client.query('SELECT pg_catalog.set_config(\'search_path\', $1, FALSE)',
        [quoteIdentifier(applicationSchema)]);

      if (!ledgerAlreadyExisted) {
        const provider = await client.query<{
          schema: string;
          unsafeCreate: boolean;
          tenantObjects: boolean;
          tenantOwned: boolean;
          allowed: boolean;
          role: string;
        }>(`
        SELECT namespace.nspname AS schema,
               EXISTS (
                 SELECT 1
                   FROM aclexplode(COALESCE(
                     namespace.nspacl,
                     acldefault('n', namespace.nspowner))) privilege
                  WHERE upper(privilege.privilege_type) = 'CREATE'
                    AND privilege.grantee <> namespace.nspowner
               ) AS "unsafeCreate",
               CASE WHEN has_schema_privilege(current_user, namespace.oid, 'USAGE')
                 THEN to_regclass(format('%I._continuum_migrations', namespace.nspname)) IS NOT NULL
                   OR (
                     to_regclass(format('%I.memories', namespace.nspname)) IS NOT NULL
                     AND to_regclass(format('%I.principals', namespace.nspname)) IS NOT NULL
                     AND to_regclass(format('%I.scopes', namespace.nspname)) IS NOT NULL
                   )
                 ELSE FALSE
               END AS "tenantObjects",
               EXISTS (
                 SELECT 1 FROM pg_namespace application
                 JOIN pg_class ledger ON ledger.relnamespace=application.oid
                   AND ledger.relname='_continuum_migrations' AND ledger.relkind='r'
                 JOIN pg_roles provider_owner ON provider_owner.oid IN
                   (namespace.nspowner,extension.extowner)
                 WHERE NOT provider_owner.rolsuper AND application.nspname<>$1
                   AND (application.nspowner=provider_owner.oid OR ledger.relowner=provider_owner.oid)
               ) AS "tenantOwned",
               has_schema_privilege(current_user, namespace.oid, 'USAGE') AS allowed,
               current_user AS role
          FROM pg_extension extension
          JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
         WHERE extension.extname = 'vector'
      `, [applicationSchema]);
        const providerState = provider.rows[0];
        if (providerState) {
        if (providerState.unsafeCreate) {
          throw new Error(
            `The pgvector provider schema ${quoteIdentifier(providerState.schema)} grants `
            + 'CREATE to PUBLIC or a non-owner; revoke CREATE before retrying',
          );
        }
        const compatibilityAccepted =
          process.env[LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN] === '1';
        if (providerState.tenantOwned && !compatibilityAccepted) {
          throw new Error(
            'Refusing a pgvector provider whose owner controls another Continuum application schema. '
            + 'Use independently owned provider infrastructure, or set '
            + `${LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN}=1 only for a reviewed legacy shared-provider compatibility opt-in`,
          );
        }
        if (providerState.schema === 'public' && applicationSchema !== 'public'
            && providerState.tenantObjects
            && !compatibilityAccepted) {
          throw new Error(
            `Refusing the shared public pgvector provider without the reviewed `
            + `${LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN}=1 compatibility opt-in`,
          );
        }
        if (providerState.schema !== applicationSchema
            && providerState.schema !== DEFAULT_VECTOR_PROVIDER_SCHEMA
            && providerState.tenantObjects && !compatibilityAccepted) {
          throw new Error(
            `Refusing to bind a fresh Continuum tenant to pgvector in another `
            + `Continuum application schema ${quoteIdentifier(providerState.schema)}. Relocate `
            + `the extension to provider infrastructure, or set `
            + `${LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN}=1 for a reviewed legacy shared-schema opt-in`,
          );
        }
        if (!providerState.allowed) {
          throw new Error(
            `The migration role cannot use the pgvector provider schema. `
            + `Grant it explicitly with GRANT USAGE ON SCHEMA `
            + `${quoteIdentifier(providerState.schema)} TO ${quoteIdentifier(providerState.role)}`,
          );
        }
          if (providerState.schema !== applicationSchema) {
            const shadows = await client.query<{ vectorType: boolean; vectorOpclass: boolean }>(`
            SELECT EXISTS (
                     SELECT 1 FROM pg_type type
                      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
                     WHERE namespace.nspname = $1 AND type.typname = 'vector'
                   ) AS "vectorType",
                   EXISTS (
                     SELECT 1 FROM pg_opclass operator_class
                      JOIN pg_namespace namespace ON namespace.oid = operator_class.opcnamespace
                     WHERE namespace.nspname = $1
                       AND operator_class.opcname = 'vector_cosine_ops'
                   ) AS "vectorOpclass"
          `, [applicationSchema]);
            if (shadows.rows[0]?.vectorType || shadows.rows[0]?.vectorOpclass) {
              throw new Error(
                `The application schema ${quoteIdentifier(applicationSchema)} shadows the `
                + `pgvector vector type or vector_cosine_ops; remove the vector shadow before retrying`,
              );
            }
          }
        }
      }
    }

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _continuum_migrations (
          name        TEXT PRIMARY KEY,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    } catch (error) {
      if ((error as { code?: string }).code === '3F000') {
        throw new Error(
          'The migration search_path does not select an application schema; '
          + 'configure a non-empty owner-controlled schema first',
          { cause: error },
        );
      }
      throw error;
    }
    migrationLedgerCreated = files.includes('0001_init.sql') && !ledgerAlreadyExisted;
    executionLedgerCreated = await ensureExecutionLedger(client);

    if (files.includes('0001_init.sql')) {
      const initialMigration = await client.query(
        'SELECT 1 FROM _continuum_migrations WHERE name = $1',
        ['0001_init.sql'],
      );
      let vectorExtension = await client.query<{ schema: string }>(
        `SELECT namespace.nspname AS schema
           FROM pg_extension extension
           JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
          WHERE extension.extname = 'vector'`,
      );
      if (!initialMigration.rowCount) {
        const schema = await client.query<{
          schema: string | null;
          owned: boolean;
          unsafeCreate: boolean;
        }>(`
          SELECT namespace.nspname AS schema,
                 (namespace.nspowner = role.oid
                   OR (namespace.nspowner = 'pg_database_owner'::regrole
                       AND role.oid = (
                         SELECT database.datdba FROM pg_database database
                          WHERE database.datname = current_database()))
                   OR (NOT role.rolsuper
                       AND pg_has_role(role.oid, namespace.nspowner, 'USAGE'))) AS owned,
                 EXISTS (
                   SELECT 1
                     FROM aclexplode(COALESCE(
                       namespace.nspacl,
                       acldefault('n', namespace.nspowner))) privilege
                    WHERE upper(privilege.privilege_type) = 'CREATE'
                      AND privilege.grantee <> namespace.nspowner
                 ) AS "unsafeCreate"
            FROM pg_roles role
            LEFT JOIN pg_namespace namespace ON namespace.nspname = current_schema()
           WHERE role.rolname = current_user
        `);
        applicationSchema = schema.rows[0]?.schema ?? undefined;
        if (!applicationSchema) {
          throw new Error(
            'The migration search_path does not select an application schema; '
            + 'configure a non-empty owner-controlled schema first',
          );
        }
        if (!schema.rows[0]?.owned || schema.rows[0]?.unsafeCreate) {
          throw new Error(
            `The application schema ${quoteIdentifier(applicationSchema)} selected by `
            + `search_path must be owner-controlled by the current migration role and must not `
            + `grant CREATE to PUBLIC or a non-owner`,
          );
        }
        if (vectorExtension.rows.length === 0) {
          // Extension installation is database-wide. Keep it under the same
          // advisory lock as 0001 and place a fresh installation in a stable
          // provider schema. App schemas can then be dropped independently.
          const providerBefore = await client.query<{ exists: boolean }>(
            'SELECT to_regnamespace($1) IS NOT NULL AS exists',
            [DEFAULT_VECTOR_PROVIDER_SCHEMA],
          );
          providerSchemaCreated = providerBefore.rows[0]?.exists !== true;
          await client.query(
            `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(DEFAULT_VECTOR_PROVIDER_SCHEMA)}`,
          );
          const providerTrust = await client.query<{
            owned: boolean;
            unsafeCreate: boolean;
          }>(`
            SELECT namespace.nspowner = role.oid AS owned,
                   EXISTS (
                     SELECT 1
                       FROM aclexplode(COALESCE(
                         namespace.nspacl,
                         acldefault('n', namespace.nspowner))) privilege
                      WHERE upper(privilege.privilege_type) = 'CREATE'
                        AND privilege.grantee <> namespace.nspowner
                   ) AS "unsafeCreate"
              FROM pg_namespace namespace
              JOIN pg_roles role ON role.rolname = current_user
             WHERE namespace.nspname = $1
          `, [DEFAULT_VECTOR_PROVIDER_SCHEMA]);
          if (providerTrust.rows[0]?.owned !== true) {
            throw new Error(
              `The fresh pgvector provider schema `
              + `${quoteIdentifier(DEFAULT_VECTOR_PROVIDER_SCHEMA)} must be owned by `
              + `the current migration role; fix ownership before retrying`,
            );
          }
          if (providerTrust.rows[0]?.unsafeCreate === true) {
            throw new Error(
              `The fresh pgvector provider schema `
              + `${quoteIdentifier(DEFAULT_VECTOR_PROVIDER_SCHEMA)} grants CREATE to `
              + `PUBLIC or a non-owner; revoke CREATE before retrying`,
            );
          }
          await client.query(
            `CREATE EXTENSION vector WITH SCHEMA ${quoteIdentifier(DEFAULT_VECTOR_PROVIDER_SCHEMA)}`,
          );
          vectorExtensionCreated = true;
          vectorExtension = await client.query<{ schema: string }>(
            `SELECT namespace.nspname AS schema
               FROM pg_extension extension
               JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
              WHERE extension.extname = 'vector'`,
          );
        }
        const vectorSchema = vectorExtension.rows[0]?.schema;
        if (vectorSchema === undefined) {
          throw new Error('The vector extension is unavailable after installation');
        }
        const vectorAccess = await client.query<{ allowed: boolean; role: string }>(
          `SELECT has_schema_privilege(current_user, $1, 'USAGE') AS allowed,
                  current_user AS role`,
          [vectorSchema],
        );
        if (vectorAccess.rows[0]?.allowed !== true) {
          const role = vectorAccess.rows[0]?.role ?? 'migration_role';
          throw new Error(
            `The migration role cannot use the pgvector provider schema. `
            + `Grant it explicitly with GRANT USAGE ON SCHEMA `
            + `${quoteIdentifier(vectorSchema)} TO ${quoteIdentifier(role)}`,
          );
        }
        if (vectorSchema !== applicationSchema) {
          const legacyTenant = await client.query<{ tenantObjects: boolean }>(`
            SELECT to_regclass(format('%I._continuum_migrations', $1::text)) IS NOT NULL
                   OR (
                     to_regclass(format('%I.memories', $1::text)) IS NOT NULL
                     AND to_regclass(format('%I.principals', $1::text)) IS NOT NULL
                     AND to_regclass(format('%I.scopes', $1::text)) IS NOT NULL
                   )
                     AS "tenantObjects"
          `, [vectorSchema]);
          if (vectorSchema !== 'public'
              && legacyTenant.rows[0]?.tenantObjects === true
              && process.env[LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN] !== '1') {
            throw new Error(
              `Refusing to bind a fresh Continuum tenant to pgvector in another `
              + `Continuum application schema ${quoteIdentifier(vectorSchema)}. Relocate `
              + `the extension to provider infrastructure, or set `
              + `${LEGACY_SHARED_VECTOR_SCHEMA_OPT_IN}=1 for a reviewed legacy shared-schema opt-in`,
            );
          }
          const shadows = await client.query<{ vectorType: boolean; vectorOpclass: boolean }>(`
            SELECT EXISTS (
                     SELECT 1 FROM pg_type type
                      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
                     WHERE namespace.nspname = $1 AND type.typname = 'vector'
                   ) AS "vectorType",
                   EXISTS (
                     SELECT 1 FROM pg_opclass operator_class
                      JOIN pg_namespace namespace ON namespace.oid = operator_class.opcnamespace
                     WHERE namespace.nspname = $1
                       AND operator_class.opcname = 'vector_cosine_ops'
                   ) AS "vectorOpclass"
          `, [applicationSchema]);
          if (shadows.rows[0]?.vectorType || shadows.rows[0]?.vectorOpclass) {
            throw new Error(
              `The application schema ${quoteIdentifier(applicationSchema!)} shadows the `
              + `pgvector vector type or vector_cosine_ops; remove the vector shadow before retrying`,
            );
          }
        }
        const searchPath = await client.query<{ path: string }>(
          `SELECT current_setting('search_path') AS path`,
        );
        originalSearchPath = searchPath.rows[0]?.path;
        if (originalSearchPath === undefined) {
          throw new Error('The migration search_path could not be read');
        }
        await client.query(
          `SELECT set_config(
             'search_path', format('%I, %I', $1::text, $2::text), FALSE
           )`,
          [applicationSchema, vectorSchema],
        );
      }
    }

    let repairPre0065StoredCrLf = false;
    if (files.includes('0074_coordination_compatibility_and_upgrade_repair.sql')) {
      const compatibility = await client.query<{ before0065: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM _continuum_migrations
            WHERE name = '0064_coordination_final_online_indexes.sql'
         ) AND NOT EXISTS (
           SELECT 1 FROM _continuum_migrations
            WHERE name = '0065_coordination_review_remediation.sql'
         ) AS "before0065"`,
      );
      repairPre0065StoredCrLf = compatibility.rows[0]?.before0065 === true;
    }

    for (const file of files) {
    for (const [reviewName, publicName] of REVIEW_ENTRA_MIGRATION_RENAMES) {
      if (!files.includes(publicName)) continue;
      await client.query(
        `INSERT INTO _continuum_migrations (name, applied_at)
         SELECT $2, applied_at FROM _continuum_migrations WHERE name = $1
         ON CONFLICT (name) DO NOTHING`,
        [reviewName, publicName],
      );
    }

      const { rowCount } = await client.query(
        'SELECT 1 FROM _continuum_migrations WHERE name = $1',
        [file],
      );
      if (rowCount && rowCount > 0) {
        await recordUnknownHistory(client, file);
        const source = verifiedSources.get(file)!;
        if (source.split('\n').some((line) => line.trim() === BACKFILL_COORDINATION_CONTRACT)) {
          await finishContractBackfill(client, file, source);
        }
        continue;
      }

      const requiredMigration = FORWARD_MIGRATION_REQUIREMENTS.get(file);
      if (requiredMigration) {
        const prerequisite = await client.query(
          'SELECT 1 FROM _continuum_migrations WHERE name = $1',
          [requiredMigration],
        );
        if (!prerequisite.rowCount) {
          throw new Error(
            `Migration ${file} requires ledgered prerequisite ${requiredMigration}`,
          );
        }
      }

      if (file === '0065_coordination_review_remediation.sql'
          && repairPre0065StoredCrLf) {
        try {
          await client.query('BEGIN');
          const execution = new MigrationExecution(file, 'pre-0065-stored-crlf',
            'owner-continuum-crlf-pairs-only-v1', null,
            sqlHash('owner-owned continuum non-extension functions; CRLF pairs only; v1'),
            sqlHash(verifiedSources.get('0074_coordination_compatibility_and_upgrade_repair.sql')!));
          await repairStoredCrLfFunctions(client, execution);
          await execution.complete(client);
          await client.query('COMMIT');
        } catch (error) {
          await rollbackExecutionTransaction(client, error);
        }
        repairPre0065StoredCrLf = false;
      }

      if (file === '0075_coordination_online_repair_finish.sql') {
        const published0074 = verifiedSources.get(
          '0074_coordination_compatibility_and_upgrade_repair.sql',
        );
        if (published0074 === undefined) {
          throw new Error('Migration 0075 requires verified 0074 source');
        }
        try {
          await client.query('BEGIN');
          const candidateSql = repaired0074CandidateFunction(published0074);
          const execution = new MigrationExecution(file, 'pre-0075-candidate-reinstall',
            '0074-candidate-reinstall-hardened-v1', sqlHash(verifiedSources.get(file)!),
            sqlHash(candidateSql), sqlHash(published0074));
          await execution.query(client, candidateSql);
          await execution.complete(client);
          await client.query('COMMIT');
        } catch (error) {
          await rollbackExecutionTransaction(client, error);
        }
      }

      // PostgreSQL preserves line endings inside dollar-quoted function bodies.
      // Execute one canonical LF form so pg_get_functiondef-based forward
      // repairs behave identically from Git LF and Windows CRLF checkouts.
      // Published-byte verification remains separate and rejects every change
      // other than Git's CRLF materialization.
      const canonicalSql = verifiedSources.get(file)!;
      const transformedSql = file === '0073_coordination_bounded_discovery_and_locking.sql'
        ? deferLegacy0073Backfill(canonicalSql)
        : file === '0074_coordination_compatibility_and_upgrade_repair.sql'
          ? repair0074PartialUpgradeDiscovery(canonicalSql)
          : file === '0076_coordination_review_2_remediation.sql'
            ? repair0076CrLfNormalization(canonicalSql)
          : canonicalSql;
      // Bound DDL waits when upgrading a parked early coordination schema,
      // without changing the published migration files. This exact prefix is
      // part of the effective SQL and the atomically recorded execution digest.
      const online = canonicalSql.trimStart().startsWith(NO_TRANSACTION_MARKER);
      const earlyTransactional = /^005[4-9]_/.test(file) && !online;
      const sql = earlyTransactional
        ? "SET LOCAL lock_timeout = '1s';\nSET LOCAL statement_timeout = '30s';\n" + transformedSql : transformedSql;
      const deferCleanup = file === '0060_coordination_online_finish.sql'
        && files.includes('0061_coordination_forward_security_repair.sql');
      const adaptiveCleanup = online && !deferCleanup
        && canonicalSql.split('\n').some((line) => line.trim() === BACKFILL_COORDINATION_REPAIR + ';');
      const baseVariant = file === '0073_coordination_bounded_discovery_and_locking.sql'
        ? '0073-online-backfill-deferred-v1'
        : file === '0074_coordination_compatibility_and_upgrade_repair.sql'
          ? '0074-partial-upgrade-discovery-crlf-v1'
          : file === '0076_coordination_review_2_remediation.sql'
            ? '0076-crlf-pairs-only-v1'
            : online ? (deferCleanup ? 'online-directives-deferred-cleanup-v1'
              : adaptiveCleanup ? 'online-cleanup-adaptive-max1000-lock1s-statement5s-progress-v3' : 'online-directives-v1')
              : earlyTransactional ? 'canonical-lf-lock1s-statement30s-v2' : 'canonical-lf-v1';
      const variant = applicationSchema ? `${baseVariant}-app-path-v1` : baseVariant;
      const execution = new MigrationExecution(file, online ? 'file-online' : 'file',
        variant, sqlHash(canonicalSql), sqlHash(sql));
      let transactionOpen = false;
      try {
        if (online) {
          // CREATE INDEX CONCURRENTLY cannot run in a transaction block. Such
          // migrations use retry-safe statements so a crash before the ledger
          // write can rerun the file.
          await execution.start(client);
          for (const statement of nonTransactionalStatements(sql)) {
            await runNonTransactionalStatement(
              client,
              statement,
              execution,
              deferCleanup,
            );
            const command = statement.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim();
            if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(command)) transactionOpen = true;
            else if (/^(?:COMMIT|ROLLBACK)\b/i.test(command)) transactionOpen = false;
          }
          transactionOpen = true;
          await client.query('BEGIN');
          await execution.complete(client, true);
          await client.query(
            'INSERT INTO _continuum_migrations (name) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
          transactionOpen = false;
        } else {
          transactionOpen = true;
          await client.query('BEGIN');
          await execution.query(client, sql);
          await execution.complete(client);
          await client.query(
            'INSERT INTO _continuum_migrations (name) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
          transactionOpen = false;
        }
        if (file === '0001_init.sql') {
          await restoreInitialMigrationSearchPath();
        }
        applied.push({ name: file, appliedAt: new Date() });
        if (canonicalSql.split('\n').some((line) => line.trim() === BACKFILL_COORDINATION_CONTRACT)) {
          await finishContractBackfill(client, file, canonicalSql);
        }
      } catch (error) {
        // Online files can install session settings before later DDL fails.
        // Preserve the original failure and unlock normally, but never return
        // that possibly contaminated session to the caller's pool.
        if (online) discardClient = true;
        const migrationError = new Error(
          `Migration ${file} failed: ${(error as Error).message}`,
          { cause: error },
        );
        const migrationCleanupErrors: unknown[] = [];
        try {
          if (transactionOpen) await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardClient = true;
          migrationCleanupErrors.push(rollbackError);
        }
        if (file === '0001_init.sql' && originalSearchPath !== undefined) {
          try {
            await restoreInitialMigrationSearchPath();
          } catch (restoreError) {
            migrationCleanupErrors.push(restoreError);
          }
        }
        if (migrationCleanupErrors.length > 0) {
          throw new AggregateError(
            [migrationError, ...migrationCleanupErrors],
            `Migration ${file} failed and cleanup failed`,
          );
        }
        throw migrationError;
      }
    }
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (originalSearchPath !== undefined) {
    try {
      await restoreInitialMigrationSearchPath();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (runFailed && applicationSchema && migrationLedgerCreated) {
    try {
      const bootstrap = await client.query<{ initialApplied: boolean; ledgerEmpty: boolean }>(`
        SELECT EXISTS (
                 SELECT 1 FROM ${quoteIdentifier(applicationSchema)}._continuum_migrations
                  WHERE name = '0001_init.sql'
               ) AS "initialApplied",
               NOT EXISTS (
                 SELECT 1 FROM ${quoteIdentifier(applicationSchema)}._continuum_migrations
               ) AS "ledgerEmpty"
      `);
      if (bootstrap.rows[0]?.initialApplied !== true) {
        if (vectorExtensionCreated) {
          await client.query('DROP EXTENSION IF EXISTS vector');
          vectorExtensionCreated = false;
        }
        if (providerSchemaCreated) {
          await client.query(
            `DROP SCHEMA IF EXISTS ${quoteIdentifier(DEFAULT_VECTOR_PROVIDER_SCHEMA)}`,
          );
          providerSchemaCreated = false;
        }
        if (bootstrap.rows[0]?.ledgerEmpty === true) {
          if (executionLedgerCreated) {
            await client.query(
              `DROP TABLE ${quoteIdentifier(applicationSchema)}._continuum_migration_execution`,
            );
          }
          await client.query(
            `DROP TABLE ${quoteIdentifier(applicationSchema)}._continuum_migrations`,
          );
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (lockAcquired) {
    try {
      const unlockResult = await client.query<{ unlocked: boolean }>(
        'SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked',
        [CONTINUUM_MIGRATION_LOCK_ID],
      );
      if (unlockResult.rows[0]?.unlocked !== true) {
        throw new Error('Continuum migration advisory lock was not held');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (callerSearchPath !== undefined) {
    try {
      await client.query('SELECT pg_catalog.set_config(\'search_path\', $1, FALSE)', [callerSearchPath]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    const unlockError = cleanupErrors[0];
    const lockError = !lockAcquired && runFailed ? runError : undefined;
    const releaseError = unlockError ?? lockError
      ?? (discardClient || executionClientIsUnsafe(client)
        ? (runError instanceof Error ? runError : new Error('Migration transaction cleanup was unsafe'))
        : undefined);
    client.release(
      releaseError instanceof Error
        ? releaseError
        : releaseError === undefined
          ? undefined
          : new Error('Migration advisory lock connection is unsafe', {
              cause: releaseError,
            }),
    );
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (runFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [runError, ...cleanupErrors],
      'Migration run failed and cleanup failed',
    );
  }
  if (runFailed) throw runError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Migration cleanup failed');
  }

  return applied;
}
