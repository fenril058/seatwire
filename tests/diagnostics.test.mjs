import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { witness } from '../src/identity.mjs';
import { launch, despawn, readLaunch, launchStatus } from '../src/spawn.mjs';
import { submitRegistration, waitReady } from '../src/registration.mjs';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'sw-diagnostics-')),old={...process.env};
 const store=new Store(join(dir,'seatwire')),session=randomUUID();
 const fake=join(dir,'agent');
 writeFileSync(fake,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
 t.after(()=>{
  try {
   const record=readLaunch(store,'test','reviewer');
   if (record?.phase==='launching') store.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({...record,phase:'running'}));
   if (record) despawn(store,'test','reviewer',true);
  } finally {
   for(const key of Object.keys(process.env)) if(!(key in old)) delete process.env[key];
   Object.assign(process.env,old);store.close();rmSync(dir,{recursive:true,force:true});
  }
 });
 const started=launch(store,'test','reviewer','codex',{cli:resolve('src/cli.mjs')});
 store.register('test','sender','claude-code');
 const read=store.send('test','sender','reviewer','handled');store.ack('test','reviewer',[read]);
 store.send('test','sender','reviewer','unread');
 const submit=()=>submitRegistration(store,'test','reviewer','codex',started.launchId,{session_id:session,cwd:process.cwd()},{});
 const hold=()=>{
  const record=readLaunch(store,'test','reviewer');
  store.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({...record,phase:'launching',starter:{pid:process.pid,witness:witness(process.pid)}}));
 };
 return {dir,store,started,submit,hold};
}
function snapshot(store) {
 return {schema:store.db.prepare('PRAGMA user_version').get(),
  tables:['agents','launches','messages','pending_registrations'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all())};
}
function seedProgress(store) {
 store.db.prepare("UPDATE agents SET notified=1,lease='fixture-lease',lease_until=?,retry_at=?,failures=2 WHERE name='reviewer'")
  .run(Date.now()+60000,Date.now()+30000);
}
for(const [stage,registration,detail] of [
 ['missing','pending','request-not-received'],
 ['pending','pending','awaiting-host-validation'],
 ['target-unavailable','pending','session-observed'],
 ['request-no-longer-pending','pending','session-observed'],
 ['error','failed','request-error'],
 ['ready','ready','ready'],
 ['revoked','revoked','revoked']
]) test(`status explains ${stage} registration without changing stored state`,async t=>{
 const {dir,store,started,submit,hold}=fixture(t);
 if(stage!=='missing') submit();
 if(stage==='pending') hold();
 if(stage==='error') store.db.prepare('UPDATE pending_registrations SET error=?').run('fixture validation failed');
 if(stage==='ready'||stage==='target-unavailable') await waitReady(store,'test','reviewer',started.launchId,1000); // No worker is running.
 if(stage==='target-unavailable') store.db.prepare("UPDATE agents SET target=json_set(target,'$.witness','expired') WHERE name='reviewer'").run();
 if(stage==='request-no-longer-pending') store.db.prepare('DELETE FROM pending_registrations').run();
 if(stage==='revoked') assert.throws(()=>submitRegistration(store,'test','reviewer','codex',started.launchId,{session_id:randomUUID(),cwd:process.cwd()},{}),/revoked/);
 // Ready/revoked must take precedence even if an old request error remains.
 if(stage==='ready'||stage==='revoked') store.db.prepare('INSERT OR REPLACE INTO pending_registrations VALUES(?,?,?,?,?,?)')
  .run(started.launchId,'test','reviewer',JSON.stringify({session:randomUUID(),token:'fixture-secret'}),'stale fixture error',Date.now());
 seedProgress(store);
 const before=snapshot(store);
 const row=launchStatus(store)[0];
 const cli=spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,'status'],{encoding:'utf8',timeout:5000});
 assert.equal(cli.status,0,cli.stderr);
 const actual=JSON.parse(cli.stdout).launches[0];
 assert.equal(actual.registration,registration);
 assert.equal(actual.registrationDetail,detail);
 assert.equal(row.registration,registration);
 assert.equal(row.registrationDetail,detail);
 assert.ok(!cli.stdout.includes('fixture-secret'));
 assert.deepEqual(snapshot(store),before);
 if(stage==='error') await assert.rejects(waitReady(store,'test','reviewer',started.launchId,1000),/registration failed: fixture validation failed/);
 if(stage==='revoked') await assert.rejects(waitReady(store,'test','reviewer',started.launchId,1000),/registration revoked/);
 if(stage==='ready') await waitReady(store,'test','reviewer',started.launchId,1000);
 assert.deepEqual(snapshot(store),before);
});
for(const received of [false,true]) test(`wait timeout explains ${received?'received':'missing'} requests and retains the launch`,async t=>{
 const {store,started,submit,hold}=fixture(t);
 if(received) { submit();hold(); }
 seedProgress(store);
 const before=snapshot(store);
 await assert.rejects(waitReady(store,'test','reviewer',started.launchId,100),error=>{
  assert.match(error.message,/registration timed out; launched agent retained/);
  assert.match(error.message,received?/awaiting-host-validation/:/request-not-received/);
  if(received) {
   assert.match(error.message,/launch phase/);
   assert.match(error.message,/wait.*host validation/i);
  } else {
   assert.match(error.message,/first turn/);
   assert.match(error.message,/trust/);
   assert.match(error.message,/environment/);
  }
  assert.doesNotMatch(error.message,/worker.*stopped|hook is untrusted/i);
  return true;
 });
 assert.deepEqual(snapshot(store),before);
 assert.equal(spawnSync('tmux',['-S',started.socket,'has-session','-t','=agent']).status,0);
});
