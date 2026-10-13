import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '..');
const helper = join(repository, 'scripts', 'container-artifact.mjs');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository, encoding: 'utf8', timeout: 10_000,
}).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const indexMediaType = 'application/vnd.oci.image.index.v1+json';
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';
const childEnvironment = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]),
);
// A managed checkout can belong to the desktop user while the test subprocess
// uses a sandbox account. Trust only this explicitly selected test repository,
// without inheriting credentials or modifying global Git configuration.
Object.assign(childEnvironment, {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: repository,
});

function fixture(context, { corruptConfig = false, privateContent = false, multipleImages = false, emptyTypeScope = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'continuum-oci-source-test-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const artifact = join(temporary, 'artifact');
  const layer = join(temporary, 'layer');
  const layout = join(temporary, 'layout');
  mkdirSync(artifact);
  mkdirSync(join(layer, 'opt', 'continuum'), { recursive: true });
  mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
  if (emptyTypeScope) mkdirSync(join(layer, 'opt', 'continuum', 'node_modules', '@types'), { recursive: true });
  writeFileSync(join(layer, 'opt', 'continuum', 'package.json'),
    privateContent ? 'CONTINUUM_PRIVATE_CONTEXT_SENTINEL_19' : '{"name":"synthetic-fixture"}');

  const layerTar = join(temporary, 'layer.tar.gz');
  execFileSync('tar', ['-czf', layerTar, '-C', layer, 'opt'], { timeout: 10_000 });
  function blob(bytes, mediaType) {
    const digest = hash(bytes);
    writeFileSync(join(layout, 'blobs', 'sha256', digest), bytes);
    return { digest: `sha256:${digest}`, size: bytes.length, mediaType };
  }
  const layerDescriptor = blob(readFileSync(layerTar), 'application/vnd.oci.image.layer.v1.tar+gzip');
  const configDescriptor = blob(Buffer.from(JSON.stringify({
    os: 'linux', architecture: 'amd64',
    config: { User: '10001:10001', Labels: { 'org.opencontainers.image.revision': sourceSha } },
  })), 'application/vnd.oci.image.config.v1+json');
  const manifestDescriptor = blob(Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: manifestMediaType, config: configDescriptor, layers: [layerDescriptor],
  })), manifestMediaType);
  const nestedDescriptor = blob(Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: indexMediaType,
    manifests: multipleImages ? [manifestDescriptor, manifestDescriptor] : [manifestDescriptor],
  })), indexMediaType);
  writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [nestedDescriptor] }));
  writeFileSync(join(layout, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  if (corruptConfig) writeFileSync(join(layout, 'blobs', 'sha256', configDescriptor.digest.slice(7)), '{}');
  execFileSync('tar', ['-cf', join(artifact, 'image.oci.tar'), '-C', layout, 'index.json', 'oci-layout', 'blobs'], {
    timeout: 10_000,
  });
  copyFileSync(join(artifact, 'image.oci.tar'), join(artifact, 'repeat.oci.tar'));
  writeFileSync(join(artifact, 'runtime-assets.tgz'), 'synthetic source test, not a deployable package');
  for (const name of ['docker-version.txt', 'compose-version.txt']) writeFileSync(join(artifact, name), 'synthetic source fixture');
  writeFileSync(join(artifact, 'buildx-version.txt'), 'github.com/docker/buildx v0.38.0 synthetic-fixture');
  writeFileSync(join(artifact, 'buildkit-inspect.txt'), 'BuildKit version: v0.34.0\n');
  return { artifact, configDescriptor, manifestDescriptor };
}

function invoke(mode, artifact) {
  return spawnSync(process.execPath, [helper, mode, artifact], {
    cwd: repository, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { ...childEnvironment, SOURCE_SHA: sourceSha },
  });
}
function rejected(artifact, expected) {
  const result = invoke('record', artifact);
  assert.equal(result.error, undefined, 'The helper must reach validation without timing out or failing to spawn');
  assert.equal(result.signal, null, 'The helper must exit through its validation error');
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`Error: ${expected}`), 'The helper must report the specific integrity rejection');
}

test('records and verifies a synthetic nested OCI index without Docker', { timeout: 20_000 }, context => {
  const { artifact, configDescriptor, manifestDescriptor } = fixture(context);
  const recorded = invoke('record', artifact);
  assert.equal(recorded.error, undefined);
  assert.equal(recorded.status, 0, recorded.stderr);
  const metadata = JSON.parse(readFileSync(join(artifact, 'source.json'), 'utf8'));
  assert.equal(metadata.manifestDigest, manifestDescriptor.digest);
  assert.equal(metadata.configDigest, configDescriptor.digest);
  assert.equal(metadata.sourceSha, sourceSha);
  const verified = invoke('verify', artifact);
  assert.equal(verified.error, undefined);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).manifestDigest, manifestDescriptor.digest);
});

test('rejects config bytes that differ from their nested manifest digest', { timeout: 20_000 }, context => {
  rejected(fixture(context, { corruptConfig: true }).artifact, 'OCI blob integrity failure');
});

test('rejects forbidden marker bytes hidden inside an otherwise allowed layer file', { timeout: 20_000 }, context => {
  rejected(fixture(context, { privateContent: true }).artifact, 'Layer content inspection failed or private marker found');
});

test('rejects multiple application descriptors inside a nested OCI index', { timeout: 20_000 }, context => {
  rejected(fixture(context, { multipleImages: true }).artifact, 'Expected one bounded application image descriptor');
});

test('identifies an empty build-only scope directory without weakening the layer gate', { timeout: 20_000 }, context => {
  rejected(fixture(context, { emptyTypeScope: true }).artifact,
    'Build-only dependency in runtime layer 0: opt/continuum/node_modules/@types/');
});
