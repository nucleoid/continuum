import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeCommandOutput,readCommandInput} from './container-binary-transfer.mjs';
test('command file streams preserve binary NUL and high bytes in both directions',()=>{
 const directory=mkdtempSync(join(tmpdir(),'continuum-transfer-'));
 try {
  const file=join(directory,'dump');
  const expected=Buffer.from(Array.from({length:65536},(_,i)=>i%256));
  writeCommandOutput(process.execPath,['-e',"process.stdout.write(Buffer.from(Array.from({length:65536},(_,i)=>i%256)))"],file);
  assert.deepEqual(readFileSync(file),expected);
  const result=readCommandInput(process.execPath,['-e',"const fs=require('fs');const b=fs.readFileSync(0);if(b.length!==65536||b.some((v,i)=>v!==i%256))process.exit(2);process.stdout.write('binary-ok')"],file);
  assert.equal(result.stdout.toString(),'binary-ok');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('output transfer refuses existing evidence without overwriting',()=>{
 const directory=mkdtempSync(join(tmpdir(),'continuum-transfer-'));
 try{const file=join(directory,'dump');writeFileSync(file,'retained');assert.throws(()=>writeCommandOutput(process.execPath,['-e','process.exit(0)'],file));assert.equal(readFileSync(file,'utf8'),'retained');}
 finally{rmSync(directory,{recursive:true,force:true});}
});
test('failed binary subprocess does not report a completed transfer',()=>{
 const directory=mkdtempSync(join(tmpdir(),'continuum-transfer-'));
 try{assert.throws(()=>writeCommandOutput(process.execPath,['-e',"process.stderr.write('synthetic-sensitive-value');process.exit(2)"],join(directory,'dump')),error=>error.message==='Binary command transfer failed');}
 finally{rmSync(directory,{recursive:true,force:true});}
});