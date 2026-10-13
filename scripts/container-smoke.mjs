import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') throw new Error('Container smoke is restricted to hosted Linux CI');
const directory = resolve(process.argv[2] ?? 'container-artifact');
const metadata = JSON.parse(readFileSync(join(directory, 'source.json')));
const source = process.env.GITHUB_SHA;
if (metadata.sourceSha !== source || !/^sha256:[a-f0-9]{64}$/.test(metadata.configDigest)) throw new Error('Unverified image identity');
execFileSync(process.execPath, ['scripts/container-artifact.mjs', 'verify', directory], { stdio: 'inherit', timeout: 600_000 });
const image = metadata.configDigest;
const owner = `continuum-ci-${randomUUID()}`;
const created = [];
const results = { sourceSha: source, imageId: image, mode: 'full-text-only', remoteMcp: 'unavailable: separate transport issue', passed: [], unmet: [] };
const command = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
const docker = (...args) => command('docker', args);
const assertion = (condition, message) => { if (!condition) throw new Error(message); };
function listFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? listFiles(join(root, item.name), `${prefix}${item.name}/`) : [`${prefix}${item.name}`]);
}
try {
  const loaded = JSON.parse(docker('image', 'inspect', image))[0];
  assertion(loaded.Id === image && loaded.Os === 'linux' && loaded.Architecture === 'amd64', 'Imported image config/platform differs from verified OCI');
  assertion(loaded.Config.Labels['org.opencontainers.image.revision'] === source, 'Imported source label differs');
  assertion(loaded.Config.User === '10001:10001', 'Image is not fixed non-root UID');
  results.passed.push('downloaded OCI integrity, platform, source and imported config ID');

  const assets = join(directory, 'runtime-assets');
  mkdirSync(assets, { recursive: false });
  const archivePaths = command('tar', ['-tzf', join(directory, 'runtime-assets.tgz')]).trim().split('\n');
  assertion(archivePaths.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'Unsafe runtime asset path');
  assertion(command('tar', ['-tvzf', join(directory, 'runtime-assets.tgz')]).trim().split('\n').every(line => ['-', 'd'].includes(line[0])), 'Runtime archive contains links or special files');
  command('tar', ['-xzf', join(directory, 'runtime-assets.tgz'), '-C', assets, '--strip-components=1', '--no-same-owner']);
  const inspectName = `${owner}-assets`;
  docker('create', '--name', inspectName, '--label', `continuum.ci.owner=${owner}`, image);
  created.push(inspectName);
  const installed = join(directory, 'installed-assets');
  mkdirSync(installed);
  docker('cp', `${inspectName}:/opt/continuum/.`, installed);
  const packageFiles = listFiles(assets);
  for (const path of packageFiles) {
    const expected = readFileSync(join(assets, path));
    const actual = readFileSync(join(installed, path));
    assertion(createHash('sha256').update(expected).digest('hex') === createHash('sha256').update(actual).digest('hex'), `Runtime package differs: ${path}`);
  }
  const sourceMigrations = readdirSync('migrations').filter(path => path.endsWith('.sql'));
  for (const path of sourceMigrations) assertion(readFileSync(join(installed, 'migrations', path)).equals(readFileSync(join('migrations', path))), `Published migration differs: ${path}`);
  assertion(packageFiles.includes('deploy/container-entrypoint.mjs'), 'Missing installed container launcher');
  results.passed.push('every public package file and current migration byte equals installed image');

  const securityName = `${owner}-security`;
  docker('run', '-d', '--name', securityName, '--label', `continuum.ci.owner=${owner}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=512m', '--cpus=1', '--pids-limit=128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864', '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 1000)');
  created.push(securityName);
  const config = JSON.parse(docker('inspect', securityName))[0];
  assertion(config.HostConfig.ReadonlyRootfs && config.HostConfig.Memory === 536870912 && config.HostConfig.NanoCpus === 1000000000 && config.HostConfig.PidsLimit === 128, 'Effective container resource configuration mismatch');
  docker('exec', securityName, 'node', '-e', `const fs=require('fs');const status=fs.readFileSync('/proc/self/status','utf8');if(process.getuid()!==10001||!/^NoNewPrivs:\\s+1$/m.test(status)||!/^CapEff:\\s+0+$/m.test(status))process.exit(1);try{fs.writeFileSync('/opt/continuum/forbidden','x');process.exit(1)}catch(e){if(e.code!=='EROFS')throw e}if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='536870912'||fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()!=='128'||fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()!=='100000 100000')process.exit(1);`);
  const help = docker('run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', image, 'continuum', '--help');
  assertion(help.startsWith('Usage: continuum <command>'), 'Installed CLI launcher failed');
  results.passed.push('actual UID, capabilities, no-new-privileges, root write denial and cgroup CPU/memory/PID limits; installed CLI help');

  const operational = resolve('scripts/container-production-smoke.mjs');
  assertion(existsSync(operational), 'Required fresh/upgrade/restore operational harness is missing');
  command(process.execPath, [operational, directory], { stdio: 'inherit', timeout: 1_800_000,
    env: { ...process.env, CONTINUUM_VERIFIED_IMAGE_ID: image, CONTINUUM_RUNTIME_ASSETS: assets, CONTINUUM_CI_OWNER: owner } });
  const operationalResults = JSON.parse(readFileSync(join(directory, 'operational-results.json')));
  assertion(operationalResults.sourceSha === source && operationalResults.imageId === image && operationalResults.unmet?.length === 0, 'Operational smoke gates are unmet or have stale identity');
  results.passed.push(...operationalResults.passed);
} catch (error) {
  results.unmet.push(error.message);
  process.exitCode = 1;
} finally {
  for (const name of created.reverse()) {
    try {
      const actual = JSON.parse(docker('inspect', name))[0];
      assertion(actual.Config.Labels['continuum.ci.owner'] === owner, 'Cleanup ownership mismatch');
      docker('rm', '-f', name);
    } catch (error) { results.unmet.push(`Cleanup: ${error.message}`); process.exitCode = 1; }
  }
  writeFileSync(join(directory, 'smoke-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
