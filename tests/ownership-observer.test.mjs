import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readlinkSync } from 'node:fs';
import { observeOwnership } from '../src/ownership.mjs';
import { currentProcess,exitedProcess } from './fixtures/process.mjs';

test('ownership evidence distinguishes present, exit, witness mismatch and namespace failures',t=>{
  const record=currentProcess();
  assert.deepEqual(observeOwnership(record),{state:'present',reason:'process-verified'});
  assert.deepEqual(observeOwnership(exitedProcess(t)),{state:'absent',reason:'process-exited'});
  assert.deepEqual(observeOwnership({...record,witness:record.witness.replace(/:\d+$/,':0')}),{state:'absent',reason:'witness-mismatch'});
  for(const pidNamespace of [null,undefined,'pid:[different]'])assert.equal(observeOwnership({...record,pidNamespace}).state,'unknown');
  assert.equal(observeOwnership({...record,witness:'expired'}).state,'unknown');
  assert.equal(observeOwnership({...record,witness:`AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA:${record.pid}:1`}).state,'unknown');
  assert.equal(observeOwnership(record,{readlink:p=>p==='/proc/self'?'wrong':readlinkSync(p)}).state,'unknown');
  assert.equal(observeOwnership(record,{readFile:(p,...args)=>p==='/proc/self/status'?'NSpid:\t1\t2\n':readFileSync(p,...args)}).state,'unknown');
});
test('permission errors and incomplete proc evidence never release a name',()=>{
  const record=currentProcess();
  for(const code of ['EACCES','EPERM','ERR_ACCESS_DENIED','EIO']) {
    const fail=()=>{throw Object.assign(Error('PRIVATE_CANARY'),{code});};
    for(const probe of [{lstat:fail},{readFile:fail},{readlink:fail}]) {
      const result=observeOwnership(record,probe);assert.equal(result.state,'unknown');assert(!JSON.stringify(result).includes('PRIVATE_CANARY'));
    }
  }
  assert.equal(observeOwnership(record,{lstat:()=>({uid:process.getuid()+1})}).state,'unknown');
  assert.equal(observeOwnership(record,{readFile:(p,...args)=>p.endsWith('/stat')?'broken':readFileSync(p,...args)}).state,'unknown');
  const missing=()=>{throw Object.assign(Error('hidden proc'),{code:'ENOENT'});};
  assert.equal(observeOwnership(record,{lstat:missing}).state,'unknown');
  assert.equal(observeOwnership(record,{lstat:missing,signal:()=>{throw Object.assign(Error('denied signal probe'),{code:'EPERM'});}}).state,'unknown');
  for(const state of ['Z','X'])assert.deepEqual(observeOwnership(record,{readFile:(p,...args)=>p===`/proc/${record.pid}/stat`?readFileSync(p,'utf8').replace(/\) \S/,') '+state):readFileSync(p,...args)}),{state:'absent',reason:'process-exited'});
});
