/** Explicit MCP contract, independent of REST's camelCase domain projection. */
export function mcpBrief(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown>={};
  for (const key of ['id','status','enabled','profile','generation','version','blocks','implementation','fresh','cutoff','coverage','watermark','diff'])
    if (Object.hasOwn(value,key)) result[key]=value[key];
  for (const [domain,wire] of [['scopeId','scope_id'],['definitionId','definition_id'],['previousVersion','previous_version'],
    ['runId','run_id'],['dryRun','dry_run'],['nextCursor','next_cursor']]) if (Object.hasOwn(value,domain)) result[wire]=value[domain];
  if (Array.isArray(value.items)) result.items=value.items.map(item=>mcpBrief(item as Record<string, unknown>));
  if (value.result) result.result=mcpBrief(value.result as Record<string, unknown>);
  return result;
}
