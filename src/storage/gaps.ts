import type { Queryable } from './queryable.js';

export interface GapCandidate {
  normalized: string;
  representative: string;
  variants: string[];
  frequency: number;
  distinctPrincipals: number;
  principalKeys: string[];
  firstSeen: Date;
  lastSeen: Date;
  scopeIds: string[];
  scopeFidelity: 'exact' | 'unknown';
}

export interface SelectGapCandidatesOptions {
  since: Date;
  scanLimit: number;
  candidateLimit: number;
  maxQueryChars: number;
}

export interface GapCandidateSelection {
  candidates: GapCandidate[];
  scannedCount: number;
  truncated: boolean;
}

function cleanDisplay(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s\u00a0]+/gu, ' ');
}

export async function selectGapCandidates(
  pool: Queryable,
  options: SelectGapCandidatesOptions,
): Promise<GapCandidateSelection> {
  const { rows } = await pool.query(
    `WITH raw_scan AS (
       SELECT id, at, principal_id, action, query, metadata
         FROM audit_log
        WHERE at >= $1
        ORDER BY at DESC, id DESC
        LIMIT $2 + 1
     ), scanned AS (
       SELECT * FROM raw_scan
        ORDER BY at DESC, id DESC
        LIMIT $2
     ), bounded AS (
       SELECT * FROM scanned
        WHERE action = 'read'
          AND query IS NOT NULL
          AND metadata->'hits' = '0'::jsonb
          AND COALESCE(metadata->>'record_kind', 'summary') = 'summary'
          AND COALESCE(metadata->>'view', '') NOT IN ('insights-gaps', 'insights-gap-probe')
        ORDER BY at DESC, id DESC
     ), clean_input AS (
       SELECT id, at, principal_id,
              btrim(regexp_replace(normalize(query, NFKC), '[[:space:] ]+', ' ', 'g')) AS display_query,
              lower(btrim(regexp_replace(normalize(query, NFKC), '[[:space:] ]+', ' ', 'g'))) AS normalized,
              metadata->'scope_ids' AS raw_scope_ids
         FROM bounded
        WHERE char_length(query) <= $3
     ), cleaned AS (
       SELECT id, at, principal_id, display_query, normalized,
              jsonb_typeof(raw_scope_ids) = 'array'
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(raw_scope_ids) = 'array'
                      THEN raw_scope_ids ELSE '[]'::jsonb END
                  ) AS element
                   WHERE jsonb_typeof(element) <> 'string'
                ) AS scope_ids_valid,
              CASE WHEN jsonb_typeof(raw_scope_ids) = 'array'
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(raw_scope_ids) = 'array'
                      THEN raw_scope_ids ELSE '[]'::jsonb END
                  ) AS element
                   WHERE jsonb_typeof(element) <> 'string'
                ) THEN (
                  SELECT COALESCE(jsonb_agg(to_jsonb(scope_id) ORDER BY scope_id), '[]'::jsonb)
                    FROM (
                      SELECT DISTINCT element #>> '{}' AS scope_id
                        FROM jsonb_array_elements(raw_scope_ids) AS element
                    ) AS canonical_scope_ids
                ) ELSE NULL END AS scope_ids
         FROM clean_input
     ), grouped AS (
       SELECT normalized,
              (array_agg(display_query ORDER BY at DESC, id DESC))[1] AS representative,
              array_agg(DISTINCT display_query ORDER BY display_query) AS variants,
              count(*)::int AS frequency,
              count(DISTINCT principal_id)::int AS distinct_principals,
              array_agg(DISTINCT principal_id) AS principal_keys,
              min(at) AS first_seen,
              max(at) AS last_seen,
              bool_and(scope_ids_valid) AS all_scope_ids_valid,
              min(scope_ids::text) AS min_scope_ids,
              max(scope_ids::text) AS max_scope_ids
         FROM cleaned
        WHERE normalized <> ''
        GROUP BY normalized
     ), ranked AS (
       SELECT normalized, representative, variants, frequency, distinct_principals,
              principal_keys, first_seen, last_seen,
              CASE WHEN all_scope_ids_valid AND min_scope_ids = max_scope_ids
                THEN min_scope_ids::jsonb ELSE NULL END AS exact_scope_ids
         FROM grouped
        ORDER BY frequency DESC, distinct_principals DESC, last_seen DESC, normalized ASC
        LIMIT $4
     )
     SELECT COALESCE(
              jsonb_agg(to_jsonb(ranked)
                ORDER BY frequency DESC, distinct_principals DESC, last_seen DESC, normalized ASC),
              '[]'::jsonb
            ) AS candidates,
            (SELECT count(*)::int FROM grouped) AS total_candidates,
            ((SELECT count(*) FROM raw_scan) > $2)::boolean AS scan_truncated,
            (SELECT count(*)::int FROM scanned) AS scanned_count
       FROM ranked`,
    [options.since, options.scanLimit, options.maxQueryChars, options.candidateLimit],
  );

  const summary = rows[0] as Record<string, unknown>;
  const candidateRows = summary.candidates as Array<Record<string, unknown>>;
  const totalCandidates = Number(summary.total_candidates);
  return {
    scannedCount: Number(summary.scanned_count),
    truncated: totalCandidates > candidateRows.length || summary.scan_truncated === true,
    candidates: candidateRows.map((row) => {
      const exactScopeIds = row.exact_scope_ids;
      const scopes = Array.isArray(exactScopeIds)
        && exactScopeIds.every((item): item is string => typeof item === 'string')
        ? { scopeIds: exactScopeIds, fidelity: 'exact' as const }
        : { scopeIds: [], fidelity: 'unknown' as const };
      const candidate: GapCandidate = {
        normalized: row.normalized as string,
        representative: row.representative as string,
        variants: (row.variants as string[]).map(cleanDisplay).slice(0, 5),
        frequency: Number(row.frequency),
        distinctPrincipals: Number(row.distinct_principals),
        principalKeys: [],
        firstSeen: new Date(row.first_seen as string),
        lastSeen: new Date(row.last_seen as string),
        scopeIds: scopes.scopeIds,
        scopeFidelity: scopes.fidelity,
      };
      // Needed only to deduplicate principals across semantic clusters. Keep
      // raw identities non-enumerable so they cannot enter service output or logs.
      Object.defineProperty(candidate, 'principalKeys', {
        value: row.principal_keys as string[], enumerable: false,
      });
      return candidate;
    }),
  };
}

export async function isGapCurrentlyResolved(
  pool: Queryable,
  query: string,
  scopeIds: readonly string[],
): Promise<boolean> {
  // An exact empty scope set means the originating recall searched no scopes.
  // It must not degrade into an unfiltered, organization-wide probe.
  if (scopeIds.length === 0) return false;
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM memories
        WHERE state = 'live'
          AND (expires_at IS NULL OR expires_at > now())
          AND scope_id = ANY($2::uuid[])
          AND to_tsvector('english', title || ' ' || body)
              @@ plainto_tsquery('english', $1)
     ) AS resolved`,
    [query, scopeIds],
  );
  return rows[0]?.resolved === true;
}
