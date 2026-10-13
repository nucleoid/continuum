import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const [mode, directory = 'container-artifact'] = process.argv.slice(2);
const root = resolve(directory);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
async function inspect(file) {
  const temp = mkdtempSync(join(tmpdir(), 'continuum-oci-'));
  try {
    const entries = run('tar', ['-tf', file]).trim().split('\n');
    if (entries.some(path => path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Unsafe OCI archive path');
    const types = run('tar', ['-tvf', file]).trim().split('\n');
    if (types.some(line => !['-', 'd'].includes(line[0]))) throw new Error('OCI archive contains unsupported links or special files');
    run('tar', ['-xf', file, '-C', temp, '--no-same-owner']);
    const index = JSON.parse(readFileSync(join(temp, 'index.json')));
    function blob(descriptor) {
      if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw new Error('Unsupported OCI digest');
      const bytes = readFileSync(join(temp, 'blobs', 'sha256', descriptor.digest.slice(7)));
      if (hash(bytes) !== descriptor.digest.slice(7) || bytes.length !== descriptor.size) throw new Error('OCI blob integrity failure');
      return bytes;
    }
    // A single-platform exporter may wrap its image in one or more OCI indexes.
    // Validate every traversed descriptor, bound nesting, and reject other images.
    function resolveManifest(descriptors, depth = 0) {
      if (depth > 4 || !Array.isArray(descriptors) || descriptors.length !== 1) throw new Error('Expected one bounded application image descriptor');
      const descriptor = descriptors[0];
      const document = JSON.parse(blob(descriptor));
      if (['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(descriptor.mediaType)) {
        if (document.schemaVersion !== 2) throw new Error('Unsupported image index schema');
        return resolveManifest(document.manifests, depth + 1);
      }
      if (!['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(descriptor.mediaType)
          || document.schemaVersion !== 2 || !Array.isArray(document.layers) || !document.config) throw new Error('Unsupported image manifest');
      return { descriptor, manifest: document };
    }
    const { descriptor, manifest } = resolveManifest(index.manifests);
    const config = JSON.parse(blob(manifest.config));
    if (config.os !== 'linux' || config.architecture !== 'amd64') throw new Error('Unsupported image platform');
    if (config.config.User !== '10001:10001') throw new Error('Unexpected runtime UID');
    const forbidden = /(?:^|\/)(?:\.git|\.fire-off|\.handoff|\.worktrees|\.agents|\.codex|tenants|\.env)(?:\/|$)|continuum-private-marker|\.(?:test|spec)\.(?:js|ts|d\.ts)$|\.map$/;
    for (const [i, descriptor] of manifest.layers.entries()) {
      blob(descriptor);
      const file = join(temp, 'blobs', 'sha256', descriptor.digest.slice(7));
      const paths = run('tar', ['-tf', file]).trim().split('\n');
      // Base-image distribution assets are outside the application package.
      const applicationPaths = paths.filter(path => path.replace(/^\.\//, '').startsWith('opt/continuum/'));
      if (applicationPaths.some(path => forbidden.test(path))) throw new Error(`Forbidden application path in layer ${i}`);
      if (applicationPaths.some(path => /node_modules\/(?:typescript|vitest|tsx|@types)\//.test(path))) throw new Error('Build-only dependency in runtime layer');
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xOf', file], { stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Layer inspection deadline exceeded')); }, 120_000);
        let tail = '', found = false;
        child.stdout.on('data', chunk => {
          const text = tail + chunk.toString('utf8');
          found ||= text.includes('CONTINUUM_PRIVATE_CONTEXT_SENTINEL_19');
          tail = text.slice(-64);
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0 || found) reject(new Error('Layer content inspection failed or private marker found'));
          else resolve();
        });
      });
    }
    if (JSON.stringify(config).includes('CONTINUUM_PRIVATE_CONTEXT_SENTINEL_19')) throw new Error('Private marker entered image config');
    return { manifestDigest: descriptor.digest, configDigest: manifest.config.digest, sourceSha: config.config.Labels?.['org.opencontainers.image.revision'], platform: 'linux/amd64', layerCount: manifest.layers.length };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (mode === 'record') {
  const info = await inspect(join(root, 'image.oci.tar'));
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  if (info.sourceSha !== sha || sha !== process.env.SOURCE_SHA) throw new Error('Image source label or exact workflow checkout mismatch');
  const repeated = await inspect(join(root, 'repeat.oci.tar'));
  if (info.manifestDigest !== repeated.manifestDigest || info.configDigest !== repeated.configDigest) throw new Error('Repeated build image digest mismatch');
  const files = ['image.oci.tar', 'runtime-assets.tgz', 'docker-version.txt', 'buildx-version.txt', 'buildkit-inspect.txt', 'compose-version.txt'];
  const buildkitOutput = readFileSync(join(root, 'buildkit-inspect.txt'), 'utf8');
  const buildkitVersions = [...new Set([...buildkitOutput.matchAll(/BuildKit(?: version)?:\s+(v[0-9.]+)/gi)].map(match => match[1]))];
  if (buildkitVersions.length !== 1 || buildkitVersions[0] !== 'v0.34.0') throw new Error('Executed BuildKit version does not match reviewed pin');
  const buildxOutput = readFileSync(join(root, 'buildx-version.txt'), 'utf8').trim();
  if (!/\bv0\.38\.0\b/.test(buildxOutput)) throw new Error('Executed Buildx version does not match reviewed pin');
  const metadata = { ...info, sourceSha: sha, sourceDateEpoch: run('git', ['show', '-s', '--format=%ct', 'HEAD']).trim(), reproducibility: 'Two hosted builds produced identical image manifest and config digests; archive byte identity is not asserted.', inputs: Object.fromEntries(['Dockerfile','.dockerignore','package-lock.json','.github/workflows/container.yml'].map(name => [name,hash(readFileSync(name))])), toolchain: { node: process.version, buildx: buildxOutput, buildkit: buildkitVersions[0] }, files: Object.fromEntries(files.map(name => [name, hash(readFileSync(join(root, name)))])) };
  writeFileSync(join(root, 'source.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(root, 'SHA256SUMS'), [...files, 'source.json'].map(name => `${hash(readFileSync(join(root, name)))}  ${name}`).join('\n') + '\n');
} else if (mode === 'verify') {
  const metadata = JSON.parse(readFileSync(join(root, 'source.json')));
  const expectedSha = process.env.SOURCE_SHA;
  if (!expectedSha || metadata.sourceSha !== expectedSha) throw new Error('Artifact does not match workflow source SHA');
  for (const [name, expected] of Object.entries(metadata.inputs)) {
    if (!['Dockerfile','.dockerignore','package-lock.json','.github/workflows/container.yml'].includes(name) || hash(readFileSync(name)) !== expected) throw new Error('Artifact build input differs from exact source checkout');
  }
  for (const [name, expected] of Object.entries(metadata.files)) {
    if (!['image.oci.tar', 'runtime-assets.tgz', 'docker-version.txt', 'buildx-version.txt', 'buildkit-inspect.txt', 'compose-version.txt'].includes(name) || hash(readFileSync(join(root, name))) !== expected) throw new Error('Artifact checksum mismatch');
  }
  for (const line of readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (image\.oci\.tar|runtime-assets\.tgz|source\.json|docker-version\.txt|buildx-version\.txt|buildkit-inspect\.txt|compose-version\.txt)$/.exec(line);
    if (!match || hash(readFileSync(join(root, match[2]))) !== match[1]) throw new Error('Checksum manifest mismatch');
  }
  const actual = await inspect(join(root, 'image.oci.tar'));
  if (Object.keys(actual).some(key => actual[key] !== metadata[key])) throw new Error('OCI identity metadata mismatch');
  process.stdout.write(`${JSON.stringify(actual)}\n`);
} else if (mode === 'verify-loaded') {
  const tag = process.argv[4];
  if (!/^continuum:import-[a-f0-9]{40}$/.test(tag ?? '') || tag !== `continuum:import-${process.env.SOURCE_SHA}`) throw new Error('Unique exact-source import tag required');
  run(process.execPath, [resolve(import.meta.dirname, 'container-artifact.mjs'), 'verify', root]);
  const metadata = JSON.parse(readFileSync(join(root, 'source.json')));
  const loaded = JSON.parse(run('docker', ['image', 'inspect', tag]))[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(loaded.Id) || loaded.Os !== 'linux' || loaded.Architecture !== 'amd64'
      || loaded.Config.Labels?.['org.opencontainers.image.revision'] !== metadata.sourceSha) throw new Error('Imported image source/platform/ID mismatch');
  const temporary = mkdtempSync(join(tmpdir(), 'continuum-loaded-'));
  try {
    const archive = join(temporary, 'image.docker.tar');
    run('docker', ['image', 'save', '--output', archive, tag]);
    const records = JSON.parse(run('tar', ['-xOf', archive, 'manifest.json']));
    if (!Array.isArray(records) || records.length !== 1 || !records[0].RepoTags?.includes(tag)) throw new Error('Docker save must contain one exact imported tag');
    const configPath = records[0].Config;
    if (typeof configPath !== 'string' || configPath.startsWith('/') || configPath.split('/').includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(configPath)) throw new Error('Unsafe Docker config path');
    const configBytes = execFileSync('tar', ['-xOf', archive, configPath], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    if (`sha256:${hash(configBytes)}` !== metadata.configDigest) throw new Error('Loaded image config bytes differ from verified OCI config');
    const info = JSON.parse(run('docker', ['info', '--format', '{{json .}}']));
    const store = { storageDriver: info.Driver, driverStatus: info.DriverStatus, serverVersion: info.ServerVersion };
    const identity = { sourceSha: metadata.sourceSha, imageId: loaded.Id, configDigest: metadata.configDigest, ociManifestDigest: metadata.manifestDigest, importTag: tag, dockerStore: store };
    writeFileSync(join(root, 'loaded-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(identity)}\n`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else { throw new Error('Usage: container-artifact.mjs record|verify|verify-loaded DIRECTORY [IMPORT_TAG]'); }
