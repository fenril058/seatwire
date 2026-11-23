import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { currentProcess, exitedProcess } from './fixtures/process.mjs';

function snapshot(store) {
  return Object.fromEntries(['agents','launches','pending_registrations','messages'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
for(const action of ['replace','offline','resume','launch','despawn','despawn-starting','despawn-legacy','despawn-socket','expected','identical']) test(`observation denied: ${action} preserves ownership and progress`,t=>{
  const base=mkdtempSync(join(tmpdir(),'sw-own-')),store=new Store(join(base,'seatwire'));
  t.after(()=>{store.close();rmSync(base,{recursive:true,force:true});});
  const old={...currentProcess(),session:randomUUID(),project:base,home:base};
  store.register('test','owner','codex',old);store.register('test','sender','codex');
  store.send('test','sender','owner','already handled');store.ack('test','owner',[1]);store.send('test','sender','owner','unread');
  store.db.prepare("UPDATE agents SET notified=1,lease='fixture-lease',lease_until=?,retry_at=?,failures=2,error='fixture error' WHERE name='owner'").run(Date.now()+60000,Date.now()+60000);
  const next=randomUUID(),launchId=randomUUID();
  if(action.startsWith('despawn'))store.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','owner',JSON.stringify(action==='despawn'
    ? {...currentProcess(),id:launchId,phase:'running',socket:join(base,'not-a-socket')}
    : {starter:currentProcess(),id:launchId,phase:'launching',socket:join(base,'not-a-socket')}));
  if(action==='despawn-legacy')store.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({pid:process.pid,witness:old.witness,id:launchId,phase:'running',socket:join(base,'not-a-socket')}));
  if(action==='despawn-socket') {
    const hidden=mkdtempSync(join(tmpdir(),'sw-own-socket-'));t.after(()=>rmSync(hidden,{recursive:true,force:true}));
    writeFileSync(join(hidden,'not-a-socket'),'fixture');
    store.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({starter:exitedProcess(t),id:launchId,phase:'failed',socket:join(hidden,'not-a-socket')}));
  }
  if(action==='expected') {
    store.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','owner',JSON.stringify({id:launchId,kind:'codex',phase:'running',mailboxSession:next}));
    store.db.prepare('INSERT INTO pending_registrations VALUES(?,?,?,?,?,?)').run(launchId,'test','owner',JSON.stringify({session:next,project:base}),null,Date.now());
  }
  const before=snapshot(store),input=join(base,'input.json');
  writeFileSync(input,JSON.stringify({base,old,next,action,launchId}));
  mkdirSync(join(base,'home'));mkdirSync(join(base,'runtime'));
  const out=openSync(join(base,'stdout'),'wx',0o600),err=openSync(join(base,'stderr'),'wx',0o600);
  let child;
  try {child=spawnSync(process.env.SHELL||'/bin/sh',['tests/fixtures/restricted-node.sh',process.execPath,resolve('.'),base,resolve('tests/fixtures/ownership-operation.mjs'),input],{stdio:['ignore',out,err],env:{HOME:join(base,'home'),PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:join(base,'runtime'),CODEX_HOME:join(base,'home')},timeout:8000});}
  finally {closeSync(out);closeSync(err);}
  assert.equal(child.status,0,readFileSync(join(base,'stderr'),'utf8'));assert(!child.error,child.error?.message);
  const result=JSON.parse(readFileSync(join(base,'stdout'),'utf8'));
  assert.equal(result.denied,'ERR_ACCESS_DENIED');assert(result.namespaceSame);assert.equal(result.oldAlive,false);
  assert.equal(result.tmuxCalls,0);
  assert.deepEqual(snapshot(store),before);
  if(action==='identical')assert.equal(result.error,null);
  else assert.match(result.error||'',/cannot verify .*ownership/);
});

test('legacy namespace-less and malformed records retain ownership except for identical replay',t=>{
  const base=mkdtempSync(join(tmpdir(),'sw-own-legacy-')),s=new Store(join(base,'seatwire'));
  t.after(()=>{s.close();rmSync(base,{recursive:true,force:true});});
  for(const target of [{pid:process.pid,witness:currentProcess().witness,session:randomUUID()},{...currentProcess(),witness:'expired',session:randomUUID()}]) {
    const who='owner-'+target.session;
    s.register('test',who,'codex',target);const before=snapshot(s);
    s.register('test',who,'codex',target);assert.deepEqual(snapshot(s),before);
    assert.throws(()=>s.register('test',who,'codex'),/cannot verify .*ownership/);
    assert.throws(()=>s.register('test',who,'codex',{...currentProcess(),session:randomUUID()}),/cannot verify .*ownership/);
    assert.deepEqual(snapshot(s),before);
  }
});

test('confirmed exit permits reassignment, offline registration and resume without changing history',t=>{
  const base=mkdtempSync(join(tmpdir(),'sw-own-exit-')),s=new Store(join(base,'seatwire'));
  t.after(()=>{s.close();rmSync(base,{recursive:true,force:true});});
  const dead={...exitedProcess(t),session:randomUUID(),project:base};
  for(const who of ['replace','offline','resume'])s.register('test',who,'codex',{...dead,session:randomUUID()});
  s.register('test','sender','codex');s.send('test','sender','resume','retained');
  const old=s.db.prepare("SELECT target FROM agents WHERE name='resume'").get();
  s.register('test','replace','codex',{...currentProcess(),session:randomUUID()});
  s.register('test','offline','codex');
  const identity=s.registerSession('codex',{...currentProcess(),session:JSON.parse(old.target).session},{source:'resume',project:{team:'mapping-changed'}});
  assert.deepEqual(identity,{team:'test',name:'resume'});
  assert.equal(s.inbox('test','resume')[0].body,'retained');assert.equal(s.inbox('test','resume')[0].read_at,null);
});
