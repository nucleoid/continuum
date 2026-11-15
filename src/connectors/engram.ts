/** Inspected tool descriptions are semantic documentation, not a delegated
 * server-to-server authorization protocol or frozen upstream response fixture.
 * This module intentionally imports no SDK and makes no network calls. */
export const engramCapabilityReport = Object.freeze({ enabled: false as const,
  inspected: Object.freeze({
    search_code: 'Repository-scoped hybrid hits; per-row repository and truncation. Corpus mode excluded.',
    search_symbols: 'Indexed symbol metadata, not immutable VCS source.',
    get_symbol: 'Source fetched on demand through VCS REST; index version does not pin these bytes.',
    get_symbols: 'Best-effort source batch with missingSymbolIds.',
    get_file_context: 'Retained history window; as_of is not historical source reconstruction.',
    contract_impact: 'Cross-repository dependencies; excluded without separate preauthorized repositories.',
  }),
  missing: Object.freeze(['versioned-server-transport', 'transport-owned-credential-delivery',
    'delegated-principal-repository-proof-and-revalidation', 'stable-approved-repository-identity',
    'exact-content-commit-versus-index-watermark', 'enforceable-wire-token-price-bounds-and-cancellation',
    'frozen-real-response-fixtures']),
});
export function createEngramEvidenceConnector(): never {
  throw new TypeError('Engram repository evidence is unavailable: delegated authority and transport capabilities are unverified');
}
