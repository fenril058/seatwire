import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../src/store.mjs';
import { observeOwnership } from '../src/ownership.mjs';
import { launch, despawn } from '../src/spawn.mjs';
import { currentProcess } from './fixtures/process.mjs';

function previousBoot(record=currentProcess()) {
  const old=record.witness.startsWith('00000000-0000-4000-8000-000000000000:')
    ? '11111111-1111-4111-8111-111111111111' : '00000000-0000-4000-8000-000000000000';
  return {...record,witness:record.witness.replace(/^[^:]+/,old)};
}
function snapshot(s, launches=true) {
  return Object.fromEntries(['agents','messages','pending_registrations',...(launches?['launches']:[])].map(table=>[table,s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sw-boot-')),s=new Store(join(dir,'seatwire'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  s.register('test','owner','codex');s.register('test','sender','codex');
  s.send('test','sender','owner','handled');s.ack('test','owner',[1]);s.send('test','sender','owner','unread');
  s.db.prepare("UPDATE agents SET notified=1,lease='retained-lease',lease_until=?,retry_at=?,failures=2,error='retained error' WHERE name='owner'").run(Date.now()+60000,Date.now()+60000);
  return {dir,s};
}
function mockCommands(t) {
  const original=cp.spawnSync,calls=[];
  cp.spawnSync=(...args)=>{calls.push(args[0]);return {status:1,stderr:'fixture: stop after ownership guard',stdout:''};};syncBuiltinESMExports();
  t.after(()=>{cp.spawnSync=original;syncBuiltinESMExports();});return calls;
}

test('different boot proves exit before namespace or process observation, including legacy targets',()=>{
  const past=previousBoot();
  for(const pidNamespace of [past.pidNamespace,'pid:[different]',undefined]) {
    let probes=0;const forbidden=()=>{probes++;throw Error('no PID observation needed');};
    assert.deepEqual(observeOwnership({...past,pidNamespace},{readlink:forbidden,lstat:forbidden,signal:forbidden}),{state:'absent',reason:'boot-changed'});
    assert.equal(probes,0);
  }
});
test('same boot, unavailable boot and malformed witnesses never bypass ownership protection',()=>{
  const current=currentProcess(),past=previousBoot(current);
  for(const pidNamespace of ['pid:[different]',undefined])assert.equal(observeOwnership({...current,pidNamespace}).state,'unknown');
  for(const readFile of [()=>{throw Object.assign(Error('denied'),{code:'EACCES'});},()=> 'not-a-boot-id'])
    for(const pidNamespace of [current.pidNamespace,'pid:[different]',undefined])assert.equal(observeOwnership({...past,pidNamespace},{readFile}).state,'unknown');
  for(const record of [{...past,witness:'expired'},{...past,witness:past.witness.toUpperCase().replace(/^[^:]+/,'NOT-A-BOOT-ID')},{...past,pid:past.pid+1}])
    assert.equal(observeOwnership(record).state,'unknown');
});
for(const legacy of [false,true])test(`previous boot: same UUID resume preserves identity and history (${legacy?'legacy':'different namespace'})`,t=>{
  const {dir,s}=fixture(t),session=randomUUID(),past={...previousBoot(),session,project:dir};
  if(legacy)delete past.pidNamespace;else past.pidNamespace='pid:[different]';
  s.db.prepare("UPDATE agents SET target=? WHERE name='owner'").run(JSON.stringify(past));
  const before=snapshot(s),identity=s.registerSession('codex',{...currentProcess(),session,project:dir},{source:'resume',project:{team:'other-project-team'}});
  assert.deepEqual(identity,{team:'test',name:'owner'});
  assert.deepEqual(s.db.prepare('SELECT * FROM messages').all(),before.messages);
  const owner=s.db.prepare("SELECT * FROM agents WHERE name='owner'").get();
  assert.equal(JSON.parse(owner.target).session,session);assert.notEqual(owner.generation,before.agents.find(a=>a.name==='owner').generation);
  assert.equal(owner.notified,0);assert.equal(owner.lease,null);assert.equal(owner.lease_until,0);
});
test('previous boot permits managed ownership guard without starting a real agent',t=>{
  const {dir,s}=fixture(t),calls=mockCommands(t),oldRuntime=process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR=dir;t.after(()=>{if(oldRuntime===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=oldRuntime;});
  for(const pidNamespace of ['pid:[different]',undefined]) {
    s.db.prepare("UPDATE agents SET target=? WHERE name='owner'").run(JSON.stringify({...previousBoot(),pidNamespace,session:randomUUID(),project:dir}));
    const before=snapshot(s),count=calls.length;
    assert.throws(()=>launch(s,'test','owner','codex',{cli:join(dir,'unused')}),/stop after ownership guard/);
    assert.equal(calls.length,count+1);assert.deepEqual(snapshot(s),before);
  }
});
for(const legacy of [false,true])for(const phase of ['running','launching','failed'])test(`previous boot: ${phase} ${legacy?'legacy':'namespace-recorded'} despawn preserves a replacement socket and all other rows`,async t=>{
  const {dir,s}=fixture(t),calls=mockCommands(t),socket=join(dir,'replacement'),server=createServer();
  let connections=0;server.on('connection',c=>{connections++;c.destroy();});
  await new Promise(r=>server.listen(socket,r));t.after(()=>new Promise(r=>server.close(r)));
  const identity=()=>{const r=previousBoot();if(legacy)delete r.pidNamespace;else r.pidNamespace='pid:[different]';return r;};
  const record={id:randomUUID(),phase,socket,starter:identity(),...(phase==='running'?{...identity(),agent:identity()}: {})};
  s.db.prepare('INSERT INTO pending_registrations VALUES(?,?,?,?,?,?)').run(record.id,'test','owner','{}','retained pending error',Date.now());
  const inode=lstatSync(socket).ino,before=snapshot(s,false);
  for(const force of [false,true]) {
    s.db.prepare('INSERT OR REPLACE INTO launches VALUES(?,?,?)').run('test','owner',JSON.stringify(record));
    assert.deepEqual(despawn(s,'test','owner',force),{state:'already stopped'});
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM launches').get().n,0);
    assert.deepEqual(snapshot(s,false),before);assert.equal(lstatSync(socket).ino,inode);
    assert.equal(connections,0);assert.equal(calls.length,0);
  }
});
test('same-boot or mixed, missing and malformed process evidence keeps managed records',t=>{
  const {dir,s}=fixture(t),calls=mockCommands(t);
  for(const pidNamespace of [undefined,'pid:[different]']) {
    const past={...previousBoot(),pidNamespace},current={...currentProcess(),pidNamespace};
    const records=[{...current},{...past,starter:current},{...past,agent:current},{...past,starter:{...past,witness:'expired'}},{...past,witness:'expired'},{starter:{...past,witness:'expired'}},{agent:past},{}];
    for(const evidence of records)for(const force of [false,true]) {
      s.db.prepare('INSERT OR REPLACE INTO launches VALUES(?,?,?)').run('test','owner',JSON.stringify({id:randomUUID(),phase:'running',socket:join(dir,'absent'),...evidence}));
      const before=snapshot(s);
      assert.throws(()=>despawn(s,'test','owner',force),/cannot verify .*ownership/);
      assert.deepEqual(snapshot(s),before);assert.equal(calls.length,0);
    }
  }
});
