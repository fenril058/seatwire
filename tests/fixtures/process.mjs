import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { witness, pidNamespace } from '../../src/identity.mjs';

export function currentProcess() {
  return {pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace()};
}
export function exitedProcess(t) {
  const dir=mkdtempSync(join(tmpdir(),'sw-exited-')), file=join(dir,'receipt');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const fd=openSync(file,'wx',0o600);
  const script=`import {witness,pidNamespace} from ${JSON.stringify(new URL('../../src/identity.mjs',import.meta.url).href)}; console.log(JSON.stringify({pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace()}));`;
  let child;
  try {child=spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',script],{stdio:['ignore',fd,'inherit'],timeout:5000});}
  finally {closeSync(fd);}
  assert.equal(child.status,0,child.error?.message);
  const record=JSON.parse(readFileSync(file,'utf8'));
  assert.throws(()=>witness(record.pid));
  return record;
}
