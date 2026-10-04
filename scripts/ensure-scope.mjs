import process from 'node:process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [kind, name] = process.argv.slice(2);
const kinds = new Set(['org', 'team', 'project', 'user', 'role']);
if (!kinds.has(kind) || name === undefined || (kind === 'org' ? name !== '' : name === '')) {
  process.stderr.write(
    'usage: node scripts/ensure-scope.mjs <org|team|project|user|role> <name>\n'
      + 'Use an empty quoted name only for org.\n',
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
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'continuum.ensure_scope',
    arguments: { kind, name },
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
} finally {
  await client.close();
}
