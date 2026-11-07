import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { witness } from '../src/identity.mjs';
import { currentIdentity } from '../src/context.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sw-lifecycle-'));
  const store=new Store(join(dir,'seatwire'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const target={session:randomUUID(),pid:process.pid,witness:witness(process.pid),project:process.cwd()};
  store.register('default','receiver','codex',target);
  store.register('default','sender','claude-code');
  return {store,target};
}
test('authoritative mailbox identity survives unavailable host process inspection',t=>{
  const {store,target}=fixture(t);
  store.targetAlive=()=>false; // The sandbox cannot observe the registered host PID.
  assert.deepEqual(currentIdentity(store,{env:{CODEX_THREAD_ID:target.session}}),{team:'default',name:'receiver'});
  assert.throws(()=>currentIdentity(store,{env:{CODEX_THREAD_ID:randomUUID()}}),/not registered/);
});
test('duplicate SessionStart preserves generation and delivered notification progress',t=>{
  const {store,target}=fixture(t);
  const id=store.send('default','sender','receiver','unread');
  const claim=store.claim();store.finish(claim,null);
  store.register('default','receiver','codex',target);
  const row=store.db.prepare('SELECT generation,notified FROM agents WHERE name=?').get('receiver');
  assert.equal(row.generation,claim.generation);
  assert.equal(row.notified,id);
  assert.equal(store.claim(),null);
});
test('operator retry reissues an unread notification without changing message or receipts',t=>{
  const {store}=fixture(t);
  const id=store.send('default','sender','receiver','retry me');
  const claim=store.claim();
  assert.throws(()=>store.retry('default','receiver'),/in progress/);
  store.finish(claim,null);
  store.retry('default','receiver');
  const next=store.claim();assert.equal(next.upto,id);
  assert.equal(store.inbox('default','receiver')[0].read_at,null);
  assert.equal(store.inbox('default','receiver',true).length,1);
});
test('resumed session retains mailbox and fences the prior notification lease',t=>{
  const {store,target}=fixture(t);
  const id=store.send('default','sender','receiver','retained');
  const claim=store.claim();
  store.db.prepare("UPDATE agents SET target=json_set(target,'$.witness','expired') WHERE name='receiver'").run();
  store.register('default','receiver','codex',target);
  store.finish(claim,null);
  assert.equal(store.status().find(a=>a.name==='receiver').notified,0);
  assert.equal(store.claim().upto,id);
});
test('peers in another PID namespace report unknown, not incorrectly offline',t=>{
  const {store,target}=fixture(t);
  store.register('default','receiver','codex',{...target,pidNamespace:'pid:[other]'});
  const peers=store.peers('default',process.cwd());
  assert.equal(peers.length,1);
  assert.equal(peers[0].online,null);
  assert.equal(store.status().find(a=>a.name==='receiver').online,null);
});
test('a shared Codex app-server does not prove an individual session is online',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sw-shared-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=`import {Store} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};
    import {witness} from ${JSON.stringify(new URL('../src/identity.mjs',import.meta.url).href)};
    const s=new Store(${JSON.stringify(join(dir,'seatwire'))});
    s.register('default','shared','codex',{pid:process.pid,witness:witness(process.pid),session:${JSON.stringify(randomUUID())},project:process.cwd()});
    console.log(JSON.stringify({status:s.status(),peers:s.peers('default',process.cwd())}));s.close();`;
  writeFileSync(join(dir,'app-server'),script);
  const result=spawnSync(process.execPath,['app-server'],{cwd:dir,argv0:'codex',encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout);
  assert.equal(observed.status[0].online,null);
  assert.equal(observed.peers[0].online,null);
});
test('a new Claude session in the same process takes over its socket without taking the old mailbox',t=>{
  const {store}=fixture(t);
  // Observed on Claude Code 2.1.316: /clear keeps the process, socket inode and token but changes the session UUID.
  const process_={pid:process.pid,witness:witness(process.pid),socket:'/run/user/test/cc.sock',socketWitness:'82:5116',token:'t',project:process.cwd()};
  const before={...process_,session:randomUUID()},after={...process_,session:randomUUID()};
  store.register('default','claude-code-before','claude-code',before);
  const unread=store.send('default','sender','claude-code-before','sent before /clear');
  store.register('default','claude-code-after','claude-code',after);
  const peers=store.peers('default',process.cwd()).map(p=>p.name);
  assert.ok(peers.includes('claude-code-after'));
  assert.ok(!peers.includes('claude-code-before'));
  assert.equal(store.delivery('default','claude-code-before').notification,'none');
  // The superseded mailbox keeps its message, unread, and is never nudged into the new conversation.
  assert.equal(store.inbox('default','claude-code-before')[0].id,unread);
  assert.equal(store.claim(),null);
  assert.match(store.status().find(a=>a.name==='claude-code-before').error,/claude-code-after/);
  // Resuming the earlier conversation in that process restores its notifications.
  store.register('default','claude-code-before','claude-code',before);
  assert.equal(store.claim().name,'claude-code-before');
});

test('status separates accepted unread from pending, in-flight, failed and acknowledged messages',t=>{
  const {store}=fixture(t);
  const state=()=>store.status().find(a=>a.name==='receiver').notification;
  assert.equal(state().state,'idle');
  const first=store.send('default','sender','receiver','first');
  assert.deepEqual(state(),{state:'pending',acceptedUnread:0,pendingUnread:1});
  const claim=store.claim();assert.equal(state().state,'in-flight');
  store.finish(claim,null);
  assert.deepEqual(state(),{state:'accepted-unacknowledged',acceptedUnread:1,pendingUnread:0});
  assert.equal(store.inbox('default','receiver')[0].read_at,null);
  const second=store.send('default','sender','receiver','second');
  assert.deepEqual(state(),{state:'pending',acceptedUnread:1,pendingUnread:1});
  store.finish(store.claim(),'fixture failure');assert.equal(state().state,'failed');
  store.ack('default','receiver',[second]);
  assert.equal(state().state,'accepted-unacknowledged');
  store.ack('default','receiver',[first]);assert.equal(state().state,'idle');
});

test('status keeps unknown liveness distinct from offline and missing targets',t=>{
  const {store,target}=fixture(t);
  store.send('default','sender','receiver','pending');
  store.register('default','receiver','codex',{...target,pidNamespace:'pid:[other]'});
  let row=store.status().find(a=>a.name==='receiver');
  assert.equal(row.online,null);assert.equal(row.notification.state,'pending');
  store.db.prepare("UPDATE agents SET target=json_set(target,'$.pidNamespace',NULL,'$.witness','expired') WHERE name='receiver'").run();
  assert.equal(store.status().find(a=>a.name==='receiver').notification.state,'offline');
  store.db.prepare("UPDATE agents SET target=NULL WHERE name='receiver'").run();
  assert.equal(store.status().find(a=>a.name==='receiver').notification.state,'no-target');
});
