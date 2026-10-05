import process from 'node:process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [kind, name, ownerPrincipalId] = process.argv.slice(2);
const kinds = new Set(['org', 'team', 'project', 'user', 'role']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!kinds.has(kind) || name === undefined || (kind === 'org' ? name !== '' : name === '')
  || (kind === 'user' ? !ownerPrincipalId || !uuid.test(ownerPrincipalId) : ownerPrincipalId !== undefined)) {
  process.stderr.write(
    'usage: node scripts/ensure-scope.mjs <org|team|project|user|role> <name> [owner-principal-uuid]\n'
      + 'Use an empty quoted name only for org. User scopes require the owner UUID.\n',
  );
  process.exit(2);
}
if (!process.env.CONTINUUM_PRINCIPAL_EXTERNAL_ID
  || !process.env.CONTINUUM_DATABASE_URL) {
  process.stderr.write(
    'CONTINUUM_PRINCIPAL_EXTERNAL_ID and CONTINUUM_DATABASE_URL are required\n',
  );
  process.exit(2);
}

const mcpEntrypoint = fileURLToPath(new URL('../dist/api/mcp.js', import.meta.url));
try {
  accessSync(mcpEntrypoint, constants.R_OK);
} catch {
  process.stderr.write('dist/api/mcp.js is missing; run npm run build first\n');
  process.exit(2);
}

const client = new Client({ name: 'continuum-scope-operator', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntrypoint],
  env: process.env,
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'continuum.ensure_scope',
    arguments: {
      kind,
      name,
      ...(ownerPrincipalId ? { owner_principal_id: ownerPrincipalId } : {}),
    },
  });
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (result.isError) {
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${text}\n`);
  }
} catch {
  process.stderr.write('continuum ensure-scope transport or startup failure\n');
  process.exitCode = 3;
} finally {
  try {
    await client.close();
  } catch {
    // Preserve the primary result or transport failure.
  }
}
