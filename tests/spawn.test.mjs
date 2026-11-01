import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { launch,despawn } from '../src/spawn.mjs';
function restoreEnvironment(previous) {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env,previous);
}
test('real tmux: literal boot prompt, resume argv, ownership refusal and forced stop',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'sw-spawn-'));
 const old={...process.env};const s=new Store(join(dir,'state'));
 t.after(()=>{try{despawn(s,'test','reviewer',true);}catch{}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 const fake=join(dir,'codex');const output=join(dir,'args.json');
 writeFileSync(fake,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),state:process.env.XDG_STATE_HOME}));\nprocess.on('SIGINT',()=>writeFileSync(${JSON.stringify(join(dir,'interrupted'))},'yes'));\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
 const prompt="quote ' and $(touch MUST_NOT_EXIST)\nnext line";
 const r=launch(s,'test','reviewer','codex',{cli:resolve('src/cli.mjs'),prompt,resume:'12345678-1234-4123-8123-123456789abc'});
 assert.equal(s.status().find(a=>a.name==='reviewer').online,false);
 for(let i=0;i<50&&!existsSync(output);i++) await new Promise(r=>setTimeout(r,20));
 const captured=JSON.parse(readFileSync(output,'utf8'));
 assert.equal(captured.state,dir);
 const args=captured.args;
 assert.equal(args.at(-1),prompt);assert.equal(args.at(-2),'12345678-1234-4123-8123-123456789abc');
 assert.equal(existsSync('MUST_NOT_EXIST'),false);
 assert.throws(()=>despawn(s,'test','stranger',true),/not a seatwire-managed/);
 assert.throws(()=>launch(s,'test','reviewer','codex',{cli:resolve('src/cli.mjs')}),/already exists/);
 const row=s.db.prepare('SELECT record FROM launches').get();const record=JSON.parse(row.record);
 s.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({...record,socketWitness:'wrong'}));
 assert.throws(()=>despawn(s,'test','reviewer',true),/socket replaced/);
 assert.equal(spawnSync('tmux',['-S',r.socket,'has-session','-t','=agent']).status,0);
 s.db.prepare('UPDATE launches SET record=?').run(row.record);
 despawn(s,'test','reviewer',false);
 for(let i=0;i<50&&!existsSync(join(dir,'interrupted'));i++) await new Promise(r=>setTimeout(r,20));
 assert.equal(readFileSync(join(dir,'interrupted'),'utf8'),'yes');
 assert.equal(despawn(s,'test','reviewer',true).state,'forced stop requested');
 assert.notEqual(spawnSync('tmux',['-S',r.socket,'has-session','-t','=agent']).status,0);
});

test('a startup hook can write the database before tmux returns', async t => {
 const dir=mkdtempSync(join(tmpdir(),'sw-lock-'));
 const old={...process.env};const s=new Store(join(dir,'state'));
 const realTmux=spawnSync('sh',['-c','command -v tmux'],{encoding:'utf8'}).stdout.trim();
 const bin=join(dir,'bin');mkdirSync(bin);
 const fake=join(dir,'codex');writeFileSync(fake,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 writeFileSync(join(bin,'tmux'),`#!${process.execPath}
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
if(process.argv.includes('new-session')) {
 const db=new DatabaseSync(${JSON.stringify(s.path)});db.exec('PRAGMA busy_timeout=100');
 db.prepare("UPDATE agents SET error='hook acquired lock' WHERE team='test' AND name='reviewer'").run();db.close();
}
const r=spawnSync(${JSON.stringify(realTmux)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);
`,{mode:0o700});
 process.env.PATH=bin+':'+old.PATH;process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
 t.after(()=>{try{despawn(s,'test','reviewer',true);}catch{}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 launch(s,'test','reviewer','codex',{cli:resolve('src/cli.mjs')});
 assert.equal(s.status().find(a=>a.name==='reviewer').error,'hook acquired lock');
});

test('host validates a managed hook without relying on hook process ancestry', async t => {
 const {submitRegistration,reconcileRegistrations,waitReady}=await import('../src/registration.mjs');
 const {randomUUID}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'sw-managed-'));
 const old={...process.env};const s=new Store(join(dir,'seatwire'));
 const fake=join(dir,'codex');writeFileSync(fake,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;process.env.XDG_STATE_HOME=dir;
 const r=launch(s,'test','codex','codex',{cli:resolve('src/cli.mjs')});
 t.after(()=>{try{despawn(s,'test','codex',true);}catch{}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 const session=randomUUID();const input={session_id:session,cwd:process.cwd()};
 submitRegistration(s,'test','codex','codex',r.launchId,input,{});
 await waitReady(s,'test','codex',r.launchId,1000);
 const row=s.db.prepare('SELECT target,generation FROM agents WHERE name=?').get('codex');
 const target=JSON.parse(row.target);
 assert.equal(target.session,session);assert.equal(target.launchId,r.launchId);
 assert.equal(s.status()[0].online,true);
 assert.throws(()=>submitRegistration(s,'test','codex','codex',randomUUID(),input,{}),/stale/);
 assert.throws(()=>submitRegistration(s,'test','codex','codex',r.launchId,{...input,session_id:randomUUID()},{}),/another session/);
 submitRegistration(s,'test','codex','codex',r.launchId,input,{});reconcileRegistrations(s);
 assert.equal(s.db.prepare('SELECT generation FROM agents WHERE name=?').get('codex').generation,row.generation);
 despawn(s,'test','codex',true);
 assert.equal(s.status()[0].online,false);
 assert.throws(()=>submitRegistration(s,'test','codex','codex',r.launchId,input,{}),/stale/);
});

test('readiness timeout preserves a launched process; abandoned reservation can be recovered',async t=>{
 const {waitReady}=await import('../src/registration.mjs');
 const dir=mkdtempSync(join(tmpdir(),'sw-recovery-'));const old={...process.env};const s=new Store(join(dir,'seatwire'));
 const fake=join(dir,'codex');writeFileSync(fake,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
 const r=launch(s,'test','codex','codex',{cli:resolve('src/cli.mjs')});
 t.after(()=>{try{despawn(s,'test','codex',true);}catch{}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(waitReady(s,'test','codex',r.launchId,100),/timed out/);
 assert.equal(spawnSync('tmux',['-S',r.socket,'has-session','-t','=agent']).status,0);
 const row=JSON.parse(s.db.prepare('SELECT record FROM launches').get().record);
 const abandoned={id:row.id,socket:row.socket,kind:row.kind,phase:'launching',starter:{pid:process.pid,witness:'expired'}};
 s.db.prepare('UPDATE launches SET record=?').run(JSON.stringify(abandoned));
 assert.equal(despawn(s,'test','codex',true).state,'forced stop requested');
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM launches').get().n,0);
});


test('spawn --wait-ready executes the generated hook and publishes its exact session', async t => {
 const {randomUUID}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'sw-hook-cli-'));const s=new Store(join(dir,'seatwire'));
 const fake=join(dir,'agent');const session=randomUUID();
 writeFileSync(fake,`#!${process.execPath}
import {spawnSync} from 'node:child_process';
const config=process.argv[process.argv.indexOf('-c')+1];
const encoded=config.slice(config.indexOf('command=')+8,-4);
const command=JSON.parse(encoded);
const hook=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({hook_event_name:'SessionStart',session_id:${JSON.stringify(session)},cwd:process.cwd()}),encoding:'utf8'});
if(hook.status!==0) {process.stderr.write(hook.stderr);process.exit(1);}
setInterval(()=>{},1000);
`,{mode:0o700});
 t.after(()=>{try{despawn(s,'test','codex',true);}catch{}s.close();rmSync(dir,{recursive:true,force:true});});
 const r=spawnSync(process.execPath,[resolve('src/cli.mjs'),'--state-home',dir,'--team','test','spawn','codex','codex','--wait-ready','--ready-timeout','5000'],{encoding:'utf8',timeout:10000,env:{...process.env,SEATWIRE_CODEX:fake,XDG_RUNTIME_DIR:dir}});
 assert.equal(r.status,0,r.stderr);
 assert.equal(JSON.parse(r.stdout).registration,'ready');
 assert.equal(JSON.parse(s.db.prepare('SELECT target FROM agents').get().target).session,session);
 assert.equal(s.status()[0].online,true);
});

test('host refuses replaced launch identity and socket without publishing a target', async t => {
 const {submitRegistration,reconcileRegistrations}=await import('../src/registration.mjs');
 const {randomUUID}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'sw-fence-'));const old={...process.env};const s=new Store(join(dir,'seatwire'));
 const fake=join(dir,'agent');writeFileSync(fake,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 process.env.SEATWIRE_CODEX=fake;process.env.XDG_RUNTIME_DIR=dir;
 const r=launch(s,'test','codex','codex',{cli:resolve('src/cli.mjs')});
 const original=s.db.prepare('SELECT record FROM launches').get().record;
 t.after(()=>{s.db.prepare('UPDATE launches SET record=?').run(original);try{despawn(s,'test','codex',true);}catch{}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 const input={session_id:randomUUID(),cwd:process.cwd()};
 submitRegistration(s,'test','codex','codex',r.launchId,input,{});
 s.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({...JSON.parse(original),id:randomUUID()}));
 reconcileRegistrations(s);
 assert.equal(s.db.prepare('SELECT target FROM agents').get().target,null);
 assert.match(s.db.prepare('SELECT error FROM pending_registrations').get().error,/reservation changed/);
 s.db.prepare('UPDATE launches SET record=?').run(JSON.stringify({...JSON.parse(original),socketWitness:'replaced'}));
 submitRegistration(s,'test','codex','codex',r.launchId,input,{});
 reconcileRegistrations(s);
 assert.equal(s.db.prepare('SELECT target FROM agents').get().target,null);
 assert.match(s.db.prepare('SELECT error FROM pending_registrations').get().error,/socket replaced/);
 assert.equal(spawnSync('tmux',['-S',r.socket,'has-session','-t','=agent']).status,0);
});

test('managed launches reuse one hook definition and do not inherit the spawner session', async t => {
 const {randomUUID}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'sw-env-'));const old={...process.env};const s=new Store(join(dir,'seatwire'));
 const bin=join(dir,'bin');mkdirSync(bin);
 const recorder=`#!${process.execPath}
import {writeFileSync} from 'node:fs';
const keys=['CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CODEX_THREAD_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDECODE','CLAUDE_PID','SEATWIRE_LAUNCH_ID','SEATWIRE_TEAM','SEATWIRE_NAME','XDG_STATE_HOME'];
writeFileSync(${JSON.stringify(dir)}+'/'+process.env.SEATWIRE_NAME+'.json',JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))}));
setInterval(()=>{},1000);
`;
 writeFileSync(join(bin,'codex'),recorder,{mode:0o700});writeFileSync(join(bin,'claude'),recorder,{mode:0o700});
 const names=['codex-a','codex-b','claude-a','claude-b'];
 t.after(()=>{for(const n of names){try{despawn(s,'test',n,true);}catch{}}restoreEnvironment(old);s.close();rmSync(dir,{recursive:true,force:true});});
 const parentLaunch=randomUUID();
 Object.assign(process.env,{PATH:bin+':'+old.PATH,SEATWIRE_CODEX:join(bin,'codex'),XDG_RUNTIME_DIR:dir,
  CLAUDE_CODE_SESSION_ID:randomUUID(),CLAUDE_SESSION_ID:randomUUID(),CODEX_THREAD_ID:randomUUID(),
  CLAUDE_CODE_MESSAGING_SOCKET:'/run/parent.sock',CLAUDE_CODE_MESSAGING_TOKEN:'parent-token',CLAUDECODE:'1',CLAUDE_PID:'4242',
  SEATWIRE_LAUNCH_ID:parentLaunch,SEATWIRE_TEAM:'parent-team',SEATWIRE_NAME:'parent'});
 const ids={};
 for(const n of names) ids[n]=launch(s,'test',n,n.startsWith('codex')?'codex':'claude-code',{cli:resolve('src/cli.mjs')}).launchId;
 const seen={};
 for(const n of names){
  for(let i=0;i<100&&!existsSync(join(dir,n+'.json'));i++) await new Promise(r=>setTimeout(r,20));
  seen[n]=JSON.parse(readFileSync(join(dir,n+'.json'),'utf8'));
 }
 // An identical definition lets a trusted hook stay trusted for the next launch.
 assert.deepEqual(seen['codex-a'].args,seen['codex-b'].args);
 assert.deepEqual(seen['claude-a'].args,seen['claude-b'].args);
 // A managed Codex owns its hook environment and process lifetime instead of a shared daemon.
 assert.equal(seen['codex-a'].args[0],'--no-daemon');
 for(const n of names){
  const env=seen[n].env;
  for(const k of ['CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CODEX_THREAD_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDECODE','CLAUDE_PID'])
   assert.equal(env[k],null,`${n} inherited ${k}`);
  assert.equal(env.SEATWIRE_LAUNCH_ID,ids[n]);
  assert.equal(env.SEATWIRE_TEAM,'test');assert.equal(env.SEATWIRE_NAME,n);
  assert.equal(env.XDG_STATE_HOME,dir);
 }
});
