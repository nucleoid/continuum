import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTmpfsMounts } from './container-compose-model.mjs';
test('rejects comma-split Compose tmpfs entries before container creation', () => {
 assert.throws(()=>validateTmpfsMounts({bootstrap:{tmpfs:['/tmp:rw','noexec','nosuid','size=16m','uid=999','gid=999']}}), /Invalid production tmpfs mount/);
});
test('accepts separate absolute mounts with bounded security options', () => {
 assert.doesNotThrow(()=>validateTmpfsMounts({bootstrap:{tmpfs:['/tmp:rw,noexec,nosuid,size=16m,uid=999,gid=999']},postgres:{tmpfs:['/tmp:rw,noexec,nosuid,size=16m','/var/run/postgresql:rw,noexec,nosuid,size=8m,uid=999,gid=999']}}));
});