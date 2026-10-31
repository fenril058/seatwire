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
    encoding:'utf8',env:{...process.env,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CLAUDE_SESSION_ID:'',CODEX_THREAD_ID:session}});
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
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{argv0:'codex',encoding:'utf8',env:{...process.env,XDG_STATE_HOME:dir,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',CODEX_THREAD_ID:session,CLAUDE_SESSION_ID:''}});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.hook,0,result.error); assert.equal(result.who,0,result.error);
  assert.equal(JSON.parse(result.identity).name,automaticName('codex',session));
  assert.equal(store.status().length,1);
});
