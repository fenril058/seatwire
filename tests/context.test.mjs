import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { witness } from '../src/identity.mjs';
import { automaticName, sessionId, currentIdentity } from '../src/context.mjs';
import { submitRegistration } from '../src/registration.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'seatwire-context-'));
  const store=new Store(join(dir,'seatwire'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const session=randomUUID();
  const target={session,pid:process.pid,witness:witness(process.pid),project:process.cwd()};
  return {dir,store,session,target};
}
test('automatic identity uses authoritative UUID and rejects conflicting metadata',()=>{
  const session=randomUUID();
  assert.equal(automaticName('codex',session),`codex-${session}`);
  assert.throws(()=>sessionId('codex',{session_id:session},{CODEX_THREAD_ID:randomUUID()}),/conflicting/);
  assert.throws(()=>sessionId('claude-code',{},{}),/authoritative/);
  assert.throws(()=>automaticName('unknown',session),/unknown/);
});
test('identity resolves custom teams, refuses ambiguity and retains offline mailbox access',t=>{
  const {store,session,target}=fixture(t);
  store.register('custom','reviewer','codex',target);
  const env={CODEX_THREAD_ID:session};
  assert.deepEqual(currentIdentity(store,{env}),{team:'custom',name:'reviewer'});
  store.register('other','reviewer','codex',target);
  assert.throws(()=>currentIdentity(store,{env}),/ambiguous/);
  assert.equal(currentIdentity(store,{env,team:'custom'}).team,'custom');
  assert.throws(()=>currentIdentity(store,{env:{CODEX_THREAD_ID:randomUUID()}}),/not registered/);
  store.db.prepare("UPDATE agents SET target=json_set(target,'$.witness','expired')").run();
  assert.equal(currentIdentity(store,{env,team:'custom'}).name,'reviewer');
});
test('discovery filters projects and dead peers without exposing transport credentials',t=>{
  const {store,target}=fixture(t);
  store.register('default','here','codex',{...target,token:'secret'});
  store.register('default','elsewhere','codex',{...target,session:randomUUID(),project:'/elsewhere'});
  store.register('default','offline','codex');
  store.register('another','hidden','codex',target);
  const peers=store.peers('default',process.cwd());
  assert.deepEqual(peers.map(p=>p.name),['here']);
  assert.ok(!JSON.stringify(peers).includes('secret'));
  assert.equal(store.peers('default',process.cwd(),true).length,3);
});
test('CLI discovers its identity, replies to sender, and leaves acknowledgement explicit',t=>{
  const {store,dir,target,session}=fixture(t);
  store.register('default','receiver','codex',target);
  store.register('default','sender','claude-code');
  const id=store.send('default','sender','receiver','question');
  const run=(...args)=>spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,...args],{
    encoding:'utf8',env:{...process.env,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:'',CODEX_THREAD_ID:session}});
  const reply=run('reply',String(id),'answer');
  assert.equal(reply.status,0,reply.stderr);
  assert.equal(store.inbox('default','sender')[0].body,'answer');
  assert.equal(store.inbox('default','receiver')[0].read_at,null);
  assert.equal(run('reply',String(JSON.parse(reply.stdout).id),'wrong recipient').status,1);
  assert.equal(JSON.parse(run('whoami').stdout).name,'receiver');
  assert.equal(JSON.parse(run('ack',String(id)).stdout).marked,1);
});
test('ordinary SessionStart with no assigned name registers and descendant commands resolve it',t=>{
  const {dir,store}=fixture(t);
  const session=randomUUID();
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const script=`import {spawnSync} from 'node:child_process';
    const hook=spawnSync(process.execPath,[${JSON.stringify(cli)},'hook','--kind','codex'],{input:JSON.stringify({session_id:${JSON.stringify(session)},cwd:process.cwd()}),encoding:'utf8'});
    const who=spawnSync(process.execPath,[${JSON.stringify(cli)},'whoami'],{encoding:'utf8'});
    console.log(JSON.stringify({hook:hook.status,who:who.status,identity:who.stdout,error:hook.stderr+who.stderr}));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{argv0:'codex',encoding:'utf8',env:{...process.env,XDG_STATE_HOME:dir,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CODEX_THREAD_ID:session,CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:''}});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.hook,0,result.error); assert.equal(result.who,0,result.error);
  assert.equal(JSON.parse(result.identity).name,automaticName('codex',session));
  assert.equal(store.status().length,1);
});
test('Claude Code tool commands resolve the mailbox from CLAUDE_CODE_SESSION_ID',t=>{
  const {store,dir,session,target}=fixture(t);
  const name=automaticName('claude-code',session);
  store.register('default',name,'claude-code',target);
  assert.deepEqual(currentIdentity(store,{env:{CLAUDE_CODE_SESSION_ID:session}}),{team:'default',name});
  const who=spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,'whoami'],{encoding:'utf8',
    env:{...process.env,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CODEX_THREAD_ID:'',CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:session}});
  assert.equal(who.status,0,who.stderr);
  assert.equal(JSON.parse(who.stdout).name,name);
  assert.equal(sessionId('claude-code',{},{CLAUDE_CODE_SESSION_ID:session}),session);
  assert.throws(()=>sessionId('claude-code',{session_id:session},{CLAUDE_CODE_SESSION_ID:randomUUID()}),/conflicting/);
});
test('a nested agent with an inherited parent session UUID never resolves to the parent mailbox',t=>{
  const {store,session:parent,target}=fixture(t);
  store.register('default','parent','claude-code',target);
  const child=randomUUID();
  const env={CLAUDE_CODE_SESSION_ID:parent,CODEX_THREAD_ID:child};
  assert.throws(()=>currentIdentity(store,{env}),/ambiguous/);
  assert.throws(()=>currentIdentity(store,{env,required:false}),/ambiguous/);
  store.register('default','child','codex',{...target,session:child});
  assert.throws(()=>currentIdentity(store,{env}),/ambiguous/);
  assert.equal(currentIdentity(store,{env:{CLAUDE_CODE_SESSION_ID:parent,CLAUDE_SESSION_ID:parent}}).name,'parent');
});

test('inherited names require a matching registered UUID while explicit names remain overrides',t=>{
  const {store,session,target}=fixture(t);
  store.register('custom','parent','claude-code',target);
  store.register('custom','offline','codex');
  const env={SEATWIRE_NAME:'parent',CLAUDE_CODE_SESSION_ID:session};
  assert.deepEqual(currentIdentity(store,{team:'custom',env}),{team:'custom',name:'parent'});
  store.targetAlive=()=>false; // Mailbox access must not require visible host PIDs.
  assert.equal(currentIdentity(store,{team:'custom',env}).name,'parent');
  for (const required of [true,false]) {
    assert.throws(()=>currentIdentity(store,{team:'custom',env:{...env,CLAUDE_CODE_SESSION_ID:randomUUID()},required}),/session.*match/);
    assert.throws(()=>currentIdentity(store,{team:'custom',env:{...env,CODEX_THREAD_ID:randomUUID()},required}),/ambiguous/);
    assert.throws(()=>currentIdentity(store,{team:'custom',env:{...env,CLAUDE_CODE_SESSION_ID:'invalid'},required}),/invalid session UUID/);
  }
  assert.equal(currentIdentity(store,{team:'custom',env:{...env,CLAUDE_SESSION_ID:session}}).name,'parent');
  assert.equal(currentIdentity(store,{team:'custom',env:{SEATWIRE_NAME:'offline'}}).name,'offline');
  assert.equal(currentIdentity(store,{team:'custom',who:'offline',env:{...env,CODEX_THREAD_ID:randomUUID()}}).name,'offline');
  assert.throws(()=>currentIdentity(store,{team:'other',env}),/not registered/);
});

test('CLI nested agents cannot read, send as, reply as or acknowledge their inherited parent identity',t=>{
  const {store,dir,session:parent,target}=fixture(t);
  store.register('custom','parent','claude-code',target);
  store.register('custom','sender','codex');
  const id=store.send('custom','sender','parent','parent-only request');
  const child=randomUUID();
  const run=(env,...args)=>spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,...args],{
    encoding:'utf8',timeout:5000,env:{...process.env,SEATWIRE_TEAM:'custom',SEATWIRE_NAME:'parent',
      CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:'',CODEX_THREAD_ID:'',...env}});
  for (const registered of [false,true]) {
    if (registered) store.register('custom','child','codex',{...target,session:child});
    for (const env of [{CODEX_THREAD_ID:child},{CODEX_THREAD_ID:child,CLAUDE_CODE_SESSION_ID:parent}]) {
      for (const args of [['whoami'],['inbox'],['history'],['ack',String(id)],['reply',String(id),'wrong reply'],['send','--to','sender','wrong sender']]) {
        const result=run(env,...args);
        assert.equal(result.status,1,result.stderr);
      }
      assert.equal(store.inbox('custom','parent')[0].read_at,null);
      assert.deepEqual(store.inbox('custom','sender',true).map(m=>[m.id,m.body]),[[id,'parent-only request']]);
    }
  }
  assert.deepEqual(JSON.parse(run({CLAUDE_CODE_SESSION_ID:parent},'whoami').stdout),{team:'custom',name:'parent'});
  assert.deepEqual(JSON.parse(run({},'whoami').stdout),{team:'custom',name:'parent'});
  const explicit=run({CODEX_THREAD_ID:child,CLAUDE_CODE_SESSION_ID:parent},'--name','child','whoami');
  assert.equal(explicit.status,0,explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout),{team:'custom',name:'child'});
});

test('a nested CLI ack leaves the parent message unread',t=>{
  const {store,dir,target}=fixture(t);
  store.register('custom','parent','claude-code',target);
  store.register('custom','sender','codex');
  const id=store.send('custom','sender','parent','must stay unread');
  const result=spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,'ack',String(id)],{
    encoding:'utf8',timeout:5000,env:{...process.env,SEATWIRE_TEAM:'custom',SEATWIRE_NAME:'parent',
      CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:target.session,CODEX_THREAD_ID:randomUUID()}});
  assert.equal(store.inbox('custom','parent',true)[0].read_at,null);
  assert.equal(result.status,1,result.stderr);
});

test('managed pending registration does not authorize an inherited mailbox name',t=>{
  const {store,dir,session,target}=fixture(t);
  const launchId=randomUUID();
  store.register('custom','managed','codex');
  store.register('custom','sender','claude-code');
  const id=store.send('custom','sender','managed','retained during registration');
  store.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('custom','managed',JSON.stringify({id:launchId,kind:'codex',phase:'launching',project:process.cwd()}));
  const run=(...args)=>spawnSync(process.execPath,['src/cli.mjs','--state-home',dir,...args],{
    encoding:'utf8',timeout:5000,env:{...process.env,SEATWIRE_TEAM:'custom',SEATWIRE_NAME:'managed',SEATWIRE_LAUNCH_ID:launchId,
      CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:'',CODEX_THREAD_ID:session}});
  for (const pending of [false,true]) {
    if (pending) submitRegistration(store,'custom','managed','codex',launchId,{session_id:session,cwd:process.cwd()});
    for (const args of [['whoami'],['inbox'],['ack',String(id)]]) {
      const result=run(...args);
      assert.equal(result.status,1,result.stderr);
      assert.match(result.stderr,/not registered/);
    }
    assert.equal(store.inbox('custom','managed')[0].read_at,null);
    const explicit=run('--name','managed','whoami');
    assert.equal(explicit.status,0,explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout),{team:'custom',name:'managed'});
  }
  store.register('custom','managed','codex',target);
  const ready=run('ack',String(id));
  assert.equal(ready.status,0,ready.stderr);
  assert.equal(JSON.parse(ready.stdout).marked,1);
  assert.equal(store.inbox('custom','managed').length,0);
});
