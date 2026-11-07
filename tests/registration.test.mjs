import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';

test('managed SessionStart submits the exact UUID without a Codex ancestor',t=>{
 const dir=mkdtempSync(join(tmpdir(),'sw-registration-'));const s=new Store(join(dir,'seatwire'));
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const id=randomUUID(),session=randomUUID();
 s.register('test','codex','codex');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','codex',JSON.stringify({id,kind:'codex',phase:'launching'}));
 const r=spawnSync(process.execPath,[resolve('src/cli.mjs'),'--team','test','--name','codex','hook','--kind','codex','--launch-id',id],{input:JSON.stringify({session_id:session,cwd:process.cwd()}),encoding:'utf8',env:{...process.env,XDG_STATE_HOME:dir}});
 assert.equal(r.status,0,r.stderr);
 const request=s.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(id);
 assert.equal(JSON.parse(request.payload).session,session);
 assert.equal(s.status()[0].online,false);
});

test('schema 1 migration preserves messages and launches', t => {
 const dir=mkdtempSync(join(tmpdir(),'sw-migration-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let s=new Store(join(dir,'seatwire'));
 s.register('test','a','codex');s.register('test','b','claude-code');
 const id=s.send('test','a','b','persist across migration');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','a',JSON.stringify({socket:'/old/socket',pid:123,witness:'old'}));
 s.db.exec('DROP TABLE pending_registrations; PRAGMA user_version=1');s.close();
 s=new Store(join(dir,'seatwire'));t.after(()=>s.close());
 assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,2);
 assert.equal(s.inbox('test','b')[0].id,id);
 assert.equal(s.inbox('test','b')[0].body,'persist across migration');
 assert.equal(JSON.parse(s.db.prepare('SELECT record FROM launches').get().record).socket,'/old/socket');
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM pending_registrations').get().n,0);
});

test('managed Claude clear permanently revokes the launch and preserves unread and lease fencing', async t => {
 const { submitRegistration } = await import('../src/registration.mjs');
 const { witness } = await import('../src/identity.mjs');
 const dir=mkdtempSync(join(tmpdir(),'sw-clear-'));const s=new Store(join(dir,'seatwire'));
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const id=randomUUID(),session=randomUUID(),other=randomUUID();
 const target={session,launchId:id,pid:process.pid,witness:witness(process.pid),socket:'/tmp/fixture.sock',socketWitness:'fixture',project:process.cwd()};
 s.register('test','claude','claude-code',target);s.register('test','sender','codex');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','claude',JSON.stringify({id,kind:'claude-code',phase:'running',project:process.cwd()}));
 const unread=s.send('test','sender','claude','keep me');const claim=s.claim();
 const input=session_id=>({session_id,cwd:process.cwd(),hook_event_name:'SessionStart'});
 const env={CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/fixture.sock'};
 assert.throws(()=>submitRegistration(s,'test','claude','claude-code',id,input(other),env),/session|original/);
 assert.equal(s.db.prepare('SELECT target FROM agents WHERE name=?').get('claude').target,null);
 assert.notEqual(s.db.prepare('SELECT generation FROM agents WHERE name=?').get('claude').generation,claim.generation);
 s.finish(claim,null);
 assert.equal(s.status().find(a=>a.name==='claude').notified,0);
 assert.equal(s.claim(),null);
 assert.deepEqual(s.inbox('test','claude').map(m=>[m.id,m.read_at]),[[unread,null]]);
 for (const source of ['startup','resume']) assert.throws(()=>submitRegistration(s,'test','claude','claude-code',id,{...input(session),source},env),/revoked/);
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM pending_registrations').get().n,0);
 assert.equal(s.db.prepare('SELECT target FROM agents WHERE name=?').get('claude').target,null);
});

function managedFixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'sw-revoked-'));let s=new Store(join(dir,'seatwire'));
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const id=randomUUID(),a=randomUUID(),b=randomUUID();
 s.register('test','claude','claude-code');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','claude',JSON.stringify({id,kind:'claude-code',phase:'launching',project:process.cwd()}));
 return {s,id,a,b,dir};
}
test('first pending UUID binds the launch and a second UUID permanently clears it',async t=>{
 const {submitRegistration}=await import('../src/registration.mjs');
 const {s,id,a,b,dir}=managedFixture(t);
 const submit=(session_id,source='startup')=>submitRegistration(s,'test','claude','claude-code',id,{session_id,source,cwd:process.cwd()},{CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/fixture.sock'});
 submit(a);submit(a);
 assert.throws(()=>submit(b));
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM pending_registrations').get().n,0);
 const generation=s.db.prepare('SELECT generation FROM agents').get().generation;
 assert.equal(JSON.parse(s.db.prepare('SELECT record FROM launches').get().record).registrationRevoked,true);
 const reopened=new Store(join(dir,'seatwire'));
 try {
  for(const source of ['startup','resume']) assert.throws(()=>submitRegistration(reopened,'test','claude','claude-code',id,{session_id:a,source,cwd:process.cwd()},{CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/fixture.sock'}),/revoked/);
 } finally {reopened.close();}
 assert.equal(s.db.prepare('SELECT generation FROM agents').get().generation,generation);
 assert.equal(s.db.prepare('SELECT target FROM agents').get().target,null);
});
for (const registered of [false,true]) test(`invalid launch or project cannot revoke a valid ${registered?'target':'pending registration'}`,async t=>{
 const {submitRegistration}=await import('../src/registration.mjs');
 const {s,id,a,b}=managedFixture(t),env={CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/fixture.sock'};
 const submit=(launchId,session_id,cwd)=>submitRegistration(s,'test','claude','claude-code',launchId,{session_id,cwd},env);
 submit(id,a,process.cwd());
 if(registered) {
  const {witness}=await import('../src/identity.mjs');
  s.register('test','claude','claude-code',{session:a,launchId:id,pid:process.pid,witness:witness(process.pid)});
 }
 const target=s.db.prepare('SELECT target FROM agents').get().target;
 const before=s.db.prepare('SELECT record FROM launches').get().record;
 assert.throws(()=>submit(randomUUID(),b,process.cwd()),/launch/);
 assert.throws(()=>submit('invalid',b,process.cwd()),/UUID/);
 assert.throws(()=>submit(id,b,'/different-project'),/project/);
 assert.equal(s.db.prepare('SELECT record FROM launches').get().record,before);
 assert.equal(s.db.prepare('SELECT target FROM agents').get().target,target);
 assert.equal(JSON.parse(s.db.prepare('SELECT payload FROM pending_registrations').get().payload).session,a);
});

test('launch publication cannot overwrite revocation observed while tmux is starting',async t=>{
 const {submitRegistration}=await import('../src/registration.mjs');
 const {updateLaunch}=await import('../src/spawn.mjs');
 const {s,id,a,b}=managedFixture(t);
 const reservation=JSON.parse(s.db.prepare('SELECT record FROM launches').get().record);
 const submit=session_id=>submitRegistration(s,'test','claude','claude-code',id,{session_id,cwd:process.cwd()},{CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/fixture.sock'});
 submit(a);assert.throws(()=>submit(b));
 updateLaunch(s,'test','claude',id,{...reservation,phase:'running'});
 assert.equal(JSON.parse(s.db.prepare('SELECT record FROM launches').get().record).registrationRevoked,true);
 assert.throws(()=>submit(a),/revoked/);
});
