import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { witness, socketWitness } from '../src/identity.mjs';
import { tick } from '../src/notify.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'seatwire-test-'));
  const s=new Store(join(dir,'seatwire'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  s.register('test','alice','claude-code'); s.register('test','bob','codex');
  return {s,dir};
}
test('offline round trip, history, exact receipts, namespace isolation and permissions',t=>{
  const {s}=fixture(t);
  const a=s.send('test','alice','bob','review');
  assert.equal(s.inbox('test','bob')[0].body,'review');
  assert.equal(s.inbox('test','bob').length,1);
  assert.equal(s.ack('test','alice',[a]),0);
  assert.equal(s.ack('test','bob',[a]),1);
  assert.equal(s.ack('test','bob',[a]),0);
  assert.equal(s.inbox('test','bob').length,0);
  s.send('test','bob','alice','done');
  assert.deepEqual(s.inbox('test','alice',true).map(m=>m.body),['review','done']);
  assert.equal(s.inbox('other','bob').length,0);
  assert.equal(statSync(s.path).mode & 0o777,0o600);
  assert.throws(()=>s.send('../bad','alice','bob','x'));
  assert.throws(()=>s.send('test','alice','unknown','x'));
});
test('multiple processes serialize writes without losing messages',async t=>{
  const {s,dir}=fixture(t);
  await Promise.all(Array.from({length:12},(_,i)=>new Promise((resolve,reject)=>{
    const c=spawn(process.execPath,['src/cli.mjs','--team','test','--name','alice','send','--to','bob',String(i)],{env:{...process.env,XDG_STATE_HOME:dir},stdio:['ignore','ignore','pipe']});
    let err='';c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(Error(err)));
  })));
  assert.equal(s.inbox('test','bob').length,12);
  assert.equal(new Set(s.inbox('test','bob').map(x=>x.id)).size,12);
});
test('lease exclusion, crash recovery, session generation fencing',t=>{
  const {s}=fixture(t);
  const target={pid:process.pid,witness:witness(process.pid),session:randomUUID()};
  s.register('test','bob','codex',target);s.send('test','alice','bob','x');
  const first=s.claim(); assert.ok(first); assert.equal(s.claim(),null);
  s.db.prepare('UPDATE agents SET lease_until=0').run();
  const next=s.claim(); assert.ok(next);s.finish(first,null);
  assert.equal(s.status().find(r=>r.name==='bob').notified,0);
  s.finish(next,null);assert.equal(s.claim(),null);
  s.register('test','bob','codex',{...target,project:'/resumed-project'});
  s.finish(next,null);assert.equal(s.status().find(r=>r.name==='bob').notified,0);
});
test('real Unix socket receives a nudge, no body; no duplicate on next poll',async t=>{
  const {s,dir}=fixture(t);const path=join(dir,'agent.sock');
  const chunks=[]; const server=createServer(c=>c.on('data',b=>chunks.push(b.toString())));
  await new Promise(r=>server.listen(path,r));t.after(()=>server.close());
  s.register('test','alice','claude-code',{pid:process.pid,witness:witness(process.pid),session:randomUUID(),socket:path,socketWitness:socketWitness(path),token:'test-token'});
  s.send('test','bob','alice','SECRET BODY');
  await tick(s);await new Promise(r=>setTimeout(r,20));
  assert.ok(chunks.join('').includes('seatwire --team test --name alice'));
  assert.ok(chunks.join('').includes("--state-home '" + dir + "' inbox"));
  assert.ok(chunks.join('').includes('ack ID'));
  assert.ok(chunks.join('').includes('test-token'));
  assert.ok(!chunks.join('').includes('SECRET BODY'));
  assert.equal(await tick(s),false); assert.equal(s.inbox('test','alice').length,1);
});
test('expired process and missing socket preserve unread data and retry',async t=>{
  const {s}=fixture(t);
  s.register('test','bob','codex',{pid:process.pid,witness:'stale',session:randomUUID()});
  s.send('test','alice','bob','retained');await tick(s);
  assert.equal(s.status().find(r=>r.name==='bob').error,'session process expired');
  assert.equal(s.inbox('test','bob')[0].body,'retained');assert.equal(s.claim(),null);
});
test('reject unknown schema without downgrading it',t=>{
  const dir=mkdtempSync(join(tmpdir(),'seatwire-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(join(dir,'messages.sqlite3'));db.exec('PRAGMA user_version=99');db.close();
  assert.throws(()=>new Store(dir),/unsupported schema/);
  const check=new DatabaseSync(join(dir,'messages.sqlite3'));assert.equal(check.prepare('PRAGMA user_version').get().user_version,99);check.close();
});
test('reject symlinks and public state directories',t=>{
  const {dir}=fixture(t);const unsafe=join(dir,'unsafe');symlinkSync(join(dir,'seatwire'),unsafe);
  assert.throws(()=>new Store(unsafe),/unsafe state/);
  chmodSync(join(dir,'seatwire'),0o755);assert.throws(()=>new Store(join(dir,'seatwire')),/unsafe state/);
});
test('live owner cannot be replaced',t=>{
  const {s}=fixture(t);s.register('test','bob','codex',{pid:process.pid,witness:witness(process.pid),session:randomUUID()});
  assert.throws(()=>s.register('test','bob','codex'),/live session/);
});
test('same PID with different session cannot replace a live registration',t=>{
  const {s}=fixture(t);const owner={pid:process.pid,witness:witness(process.pid),session:randomUUID()};
  s.register('test','bob','codex',owner);
  assert.throws(()=>s.register('test','bob','codex',{...owner,session:randomUUID()}),/live session/);
});
test('unwritable state names the directory and the sandbox instead of a bare I/O error',t=>{
  if (process.getuid()===0) return t.skip('root bypasses directory permissions');
  const dir=mkdtempSync(join(tmpdir(),'seatwire-denied-'));
  const parent=join(dir,'readonly');mkdirSync(parent,{mode:0o500});
  const state=join(dir,'seatwire');
  t.after(()=>{chmodSync(parent,0o700);chmodSync(state,0o700);rmSync(dir,{recursive:true,force:true});});
  // A missing directory that this process may not create, as in a read-only sandbox mount.
  assert.throws(()=>new Store(join(parent,'seatwire')),e=>e.message.startsWith(`cannot create state directory ${join(parent,'seatwire')}:`)&&/agent sandbox/.test(e.message));
  // An existing database whose directory cannot receive WAL files.
  const s=new Store(state);s.register('test','alice','codex');s.close();
  chmodSync(state,0o500);
  assert.throws(()=>new Store(state),e=>e.message.startsWith(`cannot write state database ${join(state,'messages.sqlite3')}:`)&&/allow it to write/.test(e.message));
  chmodSync(state,0o700);
  const reopened=new Store(state);t.after(()=>reopened.close());
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM agents').get().n,1);
});
test('send and reply tell the sender whether the recipient can be notified, not that it read the message',t=>{
  const {s,dir}=fixture(t);
  const run=(who,...args)=>{
    const r=spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,'--team','test','--name',who,...args],{encoding:'utf8',
      env:{...process.env,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:'',CODEX_THREAD_ID:''}});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const offline=run('alice','send','--to','bob','offline');
  assert.equal(offline.notification,'none');assert.match(offline.detail,/no registered session/);
  s.register('test','bob','codex',{pid:process.pid,witness:witness(process.pid),session:randomUUID()});
  const pending=run('alice','send','--to','bob','live');
  assert.equal(pending.notification,'pending');assert.match(pending.detail,/only ack/);
  s.db.prepare("UPDATE agents SET error='socket replaced',failures=2 WHERE name='bob'").run();
  const failing=run('alice','send','--to','bob','failing');
  assert.equal(failing.notification,'failing');assert.equal(failing.error,'socket replaced');
  s.db.prepare("UPDATE agents SET error=NULL,target=json_set(target,'$.witness','expired') WHERE name='bob'").run();
  const stopped=run('alice','send','--to','bob','stopped');
  assert.equal(stopped.notification,'recipient not running');
  const replied=run('bob','reply',String(offline.id),'answer');
  assert.equal(replied.to,'alice');assert.equal(replied.notification,'none');
  assert.equal(s.inbox('test','bob').length,4);
  assert.ok(s.inbox('test','bob').every(m=>m.read_at===null));
});
