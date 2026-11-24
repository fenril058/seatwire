import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Store } from '../src/store.mjs';
import { launch, despawn, quote } from '../src/spawn.mjs';
import { currentProcess, exitedProcess } from './fixtures/process.mjs';

function snapshot(s, launches=true) {
  return Object.fromEntries(['agents','pending_registrations','messages',...(launches?['launches']:[])].map(table=>[table,s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sw-legacy-')),previous={...process.env},s=new Store(join(dir,'seatwire'));
  const ready=join(dir,'ready'),interrupted=join(dir,'interrupted'),fake=join(dir,'agent');
  writeFileSync(fake,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nprocess.on('SIGINT',()=>writeFileSync(${JSON.stringify(interrupted)},'yes'));\nwriteFileSync(${JSON.stringify(ready)},'ready');\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
  let original;
  t.after(()=>{
    // Only this test's private server; never rely on a rejected legacy record for cleanup.
    if(original)spawnSync('tmux',['-S',original.socket,'kill-session','-t','=agent']);
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];
    Object.assign(process.env,previous);s.close();rmSync(dir,{recursive:true,force:true});
  });
  launch(s,'test','owner','codex',{cli:resolve('src/cli.mjs')});
  original=JSON.parse(s.db.prepare('SELECT record FROM launches').get().record);
  for(let i=0;i<100&&!existsSync(ready);i++)await new Promise(r=>setTimeout(r,20));
  assert(existsSync(ready));
  // Exactly the pre-ownership JSON structure: no namespace at any recorded level.
  const legacy=structuredClone(original);delete legacy.pidNamespace;
  delete legacy.starter.pidNamespace;delete legacy.agent.pidNamespace;
  const save=record=>s.db.prepare('UPDATE launches SET record=?').run(JSON.stringify(record));
  save(legacy);
  s.register('test','owner','codex',{...currentProcess(),session:randomUUID(),project:dir});
  s.register('test','sender','codex');s.send('test','sender','owner','handled');s.ack('test','owner',[1]);s.send('test','sender','owner','unread');
  s.db.prepare("UPDATE agents SET notified=1,lease='fixture-lease',lease_until=?,retry_at=?,failures=2,error='fixture error' WHERE name='owner'").run(Date.now()+60000,Date.now()+60000);
  return {s,dir,legacy,save,interrupted,original,fake};
}

test('legacy running server: verified interrupt preserves every row and namespace-less record',async t=>{
  const {s,interrupted}=await fixture(t),before=snapshot(s);
  assert.match(despawn(s,'test','owner',false).state,/interrupt requested/);
  for(let i=0;i<100&&!existsSync(interrupted);i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(readFileSync(interrupted,'utf8'),'yes');assert.deepEqual(snapshot(s),before);
});
test('legacy running server: verified force stops only its server and removes only its launch',async t=>{
  const {s,legacy}=await fixture(t),before=snapshot(s,false);
  assert.equal(despawn(s,'test','owner',true).state,'stopped');
  assert.notEqual(spawnSync('tmux',['-S',legacy.socket,'has-session','-t','=agent']).status,0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM launches').get().n,0);
  assert.deepEqual(snapshot(s,false),before);
});
test('legacy running server: missing evidence, exchanged socket, launch ID or PID/witness never operates',async t=>{
  const {s,legacy,save,interrupted}=await fixture(t);
  for(const patch of [{socketWitness:'replaced'},{id:randomUUID()},{pid:process.pid,witness:currentProcess().witness},{witness:legacy.witness.replace(/:\d+$/,':0')},{socketWitness:undefined},{id:undefined},{pid:undefined},{witness:'expired'},{pidNamespace:'pid:[different]'}]) {
    save({...legacy,...patch});const before=snapshot(s);
    for(const force of [false,true])assert.throws(()=>despawn(s,'test','owner',force));
    assert.deepEqual(snapshot(s),before);assert.equal(existsSync(interrupted),false);
    assert.equal(spawnSync('tmux',['-S',legacy.socket,'has-session','-t','=agent']).status,0);
  }
});
test('legacy launching and failed records without full server evidence remain protected',async t=>{
  const {s,legacy,save,interrupted}=await fixture(t);
  for(const phase of ['launching','failed']) {
    save({id:legacy.id,phase,socket:legacy.socket,starter:legacy.starter});const before=snapshot(s);
    for(const force of [false,true])assert.throws(()=>despawn(s,'test','owner',force),/cannot verify .*ownership/);
    assert.deepEqual(snapshot(s),before);assert.equal(existsSync(interrupted),false);
  }
});
test('legacy socket replacement refuses before connecting to the replacement endpoint',async t=>{
  const {s,legacy}=await fixture(t),before=snapshot(s),moved=legacy.socket+'-saved';
  renameSync(legacy.socket,moved);
  let connections=0;const replacement=createServer(socket=>{connections++;socket.destroy();});
  try {
    await new Promise(r=>replacement.listen(legacy.socket,r));
    for(const force of [false,true])assert.throws(()=>despawn(s,'test','owner',force),/cannot verify .*ownership/);
    assert.deepEqual(snapshot(s),before);assert.equal(connections,0);
  } finally {
    await new Promise(r=>replacement.close(r));renameSync(moved,legacy.socket);
  }
  assert.equal(spawnSync('tmux',['-S',legacy.socket,'has-session','-t','=agent']).status,0);
});
test('legacy disappeared server or failed socket is not evidence for forgetting the record',async t=>{
  const {s,legacy,save,original}=await fixture(t);
  assert.equal(spawnSync('tmux',['-S',original.socket,'kill-session','-t','=agent']).status,0);
  for(const record of [legacy,{id:legacy.id,phase:'failed',socket:join(resolve(tmpdir()),randomUUID()),starter:legacy.starter}]) {
    save(record);const before=snapshot(s);
    for(const force of [false,true])assert.throws(()=>despawn(s,'test','owner',force),/cannot verify .*ownership/);
    assert.deepEqual(snapshot(s),before);
  }
});
test('failed missing-socket records require positively confirmed starter exit',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sw-failed-')),s=new Store(join(dir,'seatwire'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const dead=exitedProcess(t),live=currentProcess(),legacy={...dead};delete legacy.pidNamespace;
  for(const [starter,allowed] of [[live,false],[legacy,false],[dead,true]])for(const force of [false,true]) {
    s.db.prepare('INSERT OR REPLACE INTO launches VALUES(?,?,?)').run('test','owner',JSON.stringify({id:randomUUID(),phase:'failed',socket:join(dir,'absent'),starter}));
    const before=snapshot(s);
    if(allowed) {assert.equal(despawn(s,'test','owner',force).state,'already stopped');assert.equal(s.db.prepare('SELECT count(*) AS n FROM launches').get().n,0);}
    else {assert.throws(()=>despawn(s,'test','owner',force),/still running|cannot verify .*ownership/);assert.deepEqual(snapshot(s),before);}
  }
});
test('legacy server identity is checked again by the server executing the operation',async t=>{
  const {s,dir,legacy,interrupted}=await fixture(t),before=snapshot(s);
  const real=spawnSync('sh',['-c','command -v tmux'],{encoding:'utf8'}).stdout.trim(),bin=join(dir,'bin'),raced=join(dir,'raced');mkdirSync(bin);
  writeFileSync(join(bin,'tmux'),`#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('if-shell')) {
  writeFileSync(${JSON.stringify(raced)},'yes');
  const change=spawnSync(${JSON.stringify(real)},['-S',${JSON.stringify(legacy.socket)},'set-option','-g','@seatwire-launch','exchanged']);
  if(change.status!==0)process.exit(2);
}
const r=spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});process.exit(r.status??1);
`,{mode:0o700});
  process.env.PATH=bin+':'+process.env.PATH;
  for(const force of [false,true]) {
    spawnSync(real,['-S',legacy.socket,'set-option','-g','@seatwire-launch',legacy.id]);
    assert.throws(()=>despawn(s,'test','owner',force),/identity changed/);
    assert(existsSync(raced));assert.deepEqual(snapshot(s),before);assert.equal(existsSync(interrupted),false);
    assert.equal(spawnSync(real,['-S',legacy.socket,'has-session','-t','=agent']).status,0);
  }
});
test('legacy execution connection rejects another server even with the same launch ID',async t=>{
  const {s,dir,legacy,fake,interrupted}=await fixture(t),before=snapshot(s);
  const real=spawnSync('sh',['-c','command -v tmux'],{encoding:'utf8'}).stdout.trim(),other=join(dir,'other'),bin=join(dir,'bin');mkdirSync(bin);
  assert.equal(spawnSync(real,['-S',other,'-f','/dev/null','new-session','-d','-s','agent','exec '+quote(fake),';','set-option','-g','@seatwire-launch',legacy.id]).status,0);
  t.after(()=>spawnSync(real,['-S',other,'kill-session','-t','=agent']));
  writeFileSync(join(bin,'tmux'),`#!${process.execPath}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('if-shell'))args[1]=${JSON.stringify(other)};
const r=spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});process.exit(r.status??1);
`,{mode:0o700});
  process.env.PATH=bin+':'+process.env.PATH;
  for(const force of [false,true]) {
    assert.throws(()=>despawn(s,'test','owner',force),/identity changed/);
    assert.deepEqual(snapshot(s),before);assert.equal(existsSync(interrupted),false);
    for(const socket of [legacy.socket,other])assert.equal(spawnSync(real,['-S',socket,'has-session','-t','=agent']).status,0);
  }
});
