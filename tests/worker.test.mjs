import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { witness, pidNamespace } from '../src/identity.mjs';
import { workerStatus, startWorker, observeWorker, MAX_WORKER_BYTES, MAX_WORKER_FILES, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '../src/worker.mjs';

function fixture(t) {
  const base=mkdtempSync(join(tmpdir(),'sw-worker-')), dir=join(base,'seatwire');
  const store=new Store(dir);
  store.register('test','sender','claude-code');
  store.register('test','receiver','codex',{pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace(),session:randomUUID()});
  const children=[];
  t.after(async()=>{
    for (const child of children) {
      if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      await child.closed;
    }
    store.close();rmSync(base,{recursive:true,force:true});
  });
  const env={...process.env,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',SEATWIRE_LAUNCH_ID:'',CODEX_THREAD_ID:'',CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:''};
  const cli=(...args)=>{
    const r=spawnSync(process.execPath,['src/cli.mjs','--state-home',base,'--team','test','--name','sender',...args],{env,encoding:'utf8',timeout:15000});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const record=(overrides={})=>{
    const now=Date.now();
    const r={version:1,id:randomUUID(),pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace(),mode:'daemon',startedAt:now-120000,updatedAt:now,stoppedAt:null,...overrides};
    mkdirSync(join(dir,'workers'),{mode:0o700,recursive:true});
    writeFileSync(join(dir,'workers',`${r.id}.json`),JSON.stringify(r),{mode:0o600});
    return r;
  };
  const daemon=()=>{
    const child=spawn(process.execPath,['src/cli.mjs','--state-home',base,'daemon'],{env,stdio:'ignore'});
    child.closed=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    children.push(child);return child;
  };
  return {base,dir,store,env,cli,record,daemon};
}
function snapshot(store) {
  return {schema:store.db.prepare('PRAGMA user_version').get(),tables:['agents','launches','messages','pending_registrations'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all())};
}

test('send and reply preserve mail and legacy notification while reporting missing worker records',t=>{
  const {cli,store}=fixture(t);
  const sent=cli('send','--to','receiver','retained');
  assert.equal(sent.notification,'pending');
  assert.equal(store.inbox('test','receiver')[0].id,sent.id);
  assert.equal(store.inbox('test','receiver')[0].read_at,null);
  assert.equal(sent.worker?.state,'missing');
  assert.equal(sent.worker.complete,true);
  assert.match(sent.detail,/older|unrecorded/i);
  const received=store.send('test','receiver','sender','reply to this');
  const reply=cli('reply',String(received),'answer');
  assert.equal(reply.worker.state,'missing');
  assert.equal(reply.notification,'pending');
  assert.equal(store.inbox('test','receiver').at(-1).body,'answer');
  assert.equal(store.inbox('test','sender')[0].read_at,null);
});

test('status distinguishes stale, stopped and unobservable workers without changing DB state',t=>{
  const {record,cli,store,dir}=fixture(t);
  const stale=record({updatedAt:Date.now()-60000});
  const before=snapshot(store);
  let result=cli('status');
  assert.equal(result.worker?.state,'stale');
  assert.equal(result.worker.records[0].online,true);
  assert.deepEqual(snapshot(store),before);
  record({id:stale.id,stoppedAt:Date.now()});
  result=cli('status');assert.equal(result.worker.state,'stopped');
  writeFileSync(join(dir,'workers',`${stale.id}.json`),'{broken');
  result=cli('status');assert.equal(result.worker.state,'unknown');
  assert.equal(result.worker.complete,false);
  assert.deepEqual(snapshot(store),before);
});

test('each worker is evaluated independently across namespaces and stopped records',t=>{
  const {record,cli}=fixture(t);
  const stopped=record({stoppedAt:Date.now()});
  const hidden=record({pidNamespace:'pid:[999999999]'});
  const result=cli('status');
  assert.equal(result.worker?.state,'recent');
  assert.equal(result.worker.records.find(r=>r.id===stopped.id).state,'stopped');
  const unknown=result.worker.records.find(r=>r.id===hidden.id);
  assert.equal(unknown.state,'recent');
  assert.equal(unknown.online,null);
  assert.equal(unknown.reason,'pid-namespace-unavailable');
});

test('observation is bounded by file size and by all directory entries',t=>{
  const {record,dir}=fixture(t);
  const oversized=record();
  writeFileSync(join(dir,'workers',`${oversized.id}.json`),'x'.repeat(MAX_WORKER_BYTES+1));
  let status=workerStatus(dir);
  assert.equal(status.state,'unknown');assert.equal(status.complete,false);
  assert.equal(status.records[0].reason,'record-too-large');
  writeFileSync(join(dir,'workers',`${oversized.id}.json`),JSON.stringify(oversized).padEnd(MAX_WORKER_BYTES,' '));
  status=workerStatus(dir);assert.equal(status.state,'recent');assert.equal(status.complete,true);
  for(let i=1;i<MAX_WORKER_FILES;i++) record();
  status=workerStatus(dir);
  assert.equal(status.complete,true);assert.equal(status.records.length,MAX_WORKER_FILES);
  // Even an ignored temporary entry counts, regardless of enumeration order.
  writeFileSync(join(dir,'workers','overflow.tmp'),'');
  status=workerStatus(dir);
  assert.equal(status.complete,false);assert.equal(status.reason,'file-count-limit');
  assert.equal(status.state,'recent');assert.ok(status.records.length<=MAX_WORKER_FILES);
});

test('unknown record formats, symlinks and unsafe paths preserve mail and DB state',t=>{
  const {record,dir,cli,store}=fixture(t);
  const r=record({version:2,token:'fixture-secret'});
  const before=snapshot(store);
  assert.equal(cli('status').worker.complete,false);
  const path=join(dir,'workers',`${r.id}.json`);
  rmSync(path);symlinkSync('/dev/zero',path);
  const result=cli('send','--to','receiver','survives unreadable metadata');
  assert.equal(result.worker.state,'unknown');assert.equal(result.worker.complete,false);
  assert.equal(result.notification,'pending');
  assert.equal(store.inbox('test','receiver')[0].body,'survives unreadable metadata');
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  const after=snapshot(store);
  assert.deepEqual(after.schema,before.schema);
  assert.deepEqual(after.tables.filter((_,i)=>i!==2),before.tables.filter((_,i)=>i!==2));
});

test('heartbeat freshness boundaries and process observations are independent',t=>{
  const {record,dir}=fixture(t);
  const now=Date.now(), r=record({updatedAt:now});
  assert.equal(workerStatus(dir,{now:now+HEARTBEAT_STALE_MS-1}).state,'recent');
  let status=workerStatus(dir,{now:now+HEARTBEAT_STALE_MS});
  assert.equal(status.state,'stale');assert.equal(status.records[0].online,true);
  record({...r,updatedAt:now+1});
  status=workerStatus(dir,{now});
  assert.equal(status.state,'unknown');assert.equal(status.records[0].reason,'clock-invalid');
  record({...r,witness:r.witness.replace(/:\d+$/,':0')});
  status=workerStatus(dir,{now});
  assert.equal(status.state,'stopped');assert.equal(status.records[0].online,false);
  const denied=()=>{throw Object.assign(Error('denied'),{code:'EACCES'});};
  assert.deepEqual(observeWorker(r,{readFile:denied}),{online:null,reason:'process-unobservable'});
  const bootMissing=()=>{throw Object.assign(Error('hidden'),{code:'ENOENT'});};
  assert.deepEqual(observeWorker(r,{readFile:bootMissing}),{online:null,reason:'process-unobservable'});
  const ancestorProc=(path,encoding)=>path==='/proc/self/status'?`NSpid:\t${process.pid}\t${process.pid}\n`:readFileSync(path,encoding);
  assert.deepEqual(observeWorker(r,{readFile:ancestorProc}),{online:null,reason:'proc-namespace-unavailable'});
  assert.deepEqual(observeWorker({...r,witness:`00000000-0000-4000-8000-000000000000:${r.pid}:0`}),{online:false,reason:'boot-changed'});
});

test('reporter updates on the loop cadence, preserves private records on stop and never creates a DB',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sw-heartbeat-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let time=Date.now();const worker=startWorker(dir,{now:()=>time});
  const files=()=>readdirSync(join(dir,'workers'));
  const record=()=>JSON.parse(readFileSync(join(dir,'workers',files()[0]),'utf8'));
  const initial=record();assert.equal(initial.updatedAt,time);
  time+=HEARTBEAT_INTERVAL_MS-1;worker.update();assert.equal(record().updatedAt,initial.updatedAt);
  time++;worker.update();assert.equal(record().updatedAt,time);
  worker.stop();assert.equal(record().stoppedAt,time);
  time+=HEARTBEAT_INTERVAL_MS;worker.update();assert.equal(record().stoppedAt,time-HEARTBEAT_INTERVAL_MS);
  assert.equal(statSync(join(dir,'workers')).mode&0o777,0o700);
  assert.equal(statSync(join(dir,'workers',files()[0])).mode&0o777,0o600);
  assert.deepEqual(readdirSync(dir),['workers']);
});

test('recording failure warns once without failing notification acceptance or marking mail read',t=>{
  const {dir,cli,store,env}=fixture(t);
  writeFileSync(join(dir,'workers'),'not a directory');
  const warnings=[];
  const reporter=startWorker(dir,{warn:m=>warnings.push(m)});
  reporter.update();reporter.stop();assert.equal(warnings.length,1);
  const fake=join(dir,'queue');
  writeFileSync(fake,`#!${process.execPath}\nconsole.log('Queued message 12345678-1234-4123-8123-123456789abc for thread '+process.argv[4]+'.');\n`,{mode:0o700});
  const target=JSON.parse(store.db.prepare("SELECT target FROM agents WHERE name='receiver'").get().target);
  store.register('test','receiver','codex',{...target,home:dir});
  const sent=cli('send','--to','receiver','saved');
  assert.equal(sent.worker.state,'unknown');assert.equal(sent.worker.complete,false);
  const once=spawnSync(process.execPath,['src/cli.mjs','--state-home',join(dir,'..'),'daemon','--once'],{env:{...env,SEATWIRE_CODEX:fake},encoding:'utf8',timeout:10000});
  assert.equal(once.status,0,once.stderr);assert.match(once.stderr,/diagnostics could not be recorded/);
  const receiver=store.status().find(r=>r.name==='receiver');
  assert.equal(receiver.notified,sent.id);assert.equal(receiver.unread,1);
  assert.deepEqual(receiver.notification,{state:'accepted-unacknowledged',acceptedUnread:1,pendingUnread:0});
  assert.equal(store.inbox('test','receiver')[0].read_at,null);
});

test('daemon --once is recorded as a single run rather than a continuous worker',t=>{
  const {base,cli,env,store}=fixture(t);
  const before=snapshot(store);
  const once=spawnSync(process.execPath,['src/cli.mjs','--state-home',base,'daemon','--once'],{env,encoding:'utf8',timeout:10000});
  assert.equal(once.status,0,once.stderr);
  const worker=cli('status').worker;
  assert.equal(worker.state,'missing');assert.equal(worker.complete,true);
  assert.equal(worker.records.length,1);assert.equal(worker.records[0].mode,'once');
  assert.equal(worker.records[0].state,'stopped');assert.ok(worker.lastSeenAt>0);
  assert.deepEqual(snapshot(store),before);
});

async function waitFor(read) {
  const end=Date.now()+10000;
  do { const result=read();if(result) return result;await new Promise(r=>setTimeout(r,25)); } while(Date.now()<end);
  assert.fail('timed out waiting for isolated daemon');
}

test('two real daemons retain separate heartbeats through updates, graceful stop and forced exit', {timeout:25000},async t=>{
  const {daemon,dir,store}=fixture(t), before=snapshot(store);
  const first=daemon(), second=daemon();
  let status=await waitFor(()=>{
    const w=workerStatus(dir);return w.records.length===2 && w.records.every(r=>r.state==='recent') && w;
  });
  assert.equal(status.state,'recent');assert.equal(status.complete,true);
  assert.ok(status.records.every(r=>r.online===true));
  const initial=status.records.map(r=>r.lastSeenAt);
  status=await waitFor(()=>{
    const w=workerStatus(dir);return w.records.every(r=>r.lastSeenAt>Math.max(...initial)) && w;
  });
  assert.equal(status.records.length,2);
  first.kill('SIGTERM');await first.closed;
  status=workerStatus(dir);
  assert.equal(status.state,'recent');assert.equal(status.records.filter(r=>r.state==='stopped').length,1);
  second.kill('SIGKILL');await second.closed;
  status=workerStatus(dir);
  assert.equal(status.state,'stopped');assert.equal(status.records.length,2);
  assert.ok(status.records.every(r=>r.online===false));
  assert.ok(status.records.some(r=>r.reason==='loop-ended'));
  assert.ok(status.records.some(r=>r.reason==='process-exited'));
  assert.deepEqual(snapshot(store),before);
});

test('doctor and status share diagnostics without treating recent activity as message consumption',t=>{
  const {record,dir,cli,env,store}=fixture(t);
  record();
  const bin=join(dir,'bin');mkdirSync(bin,{mode:0o700});
  for(const cmd of ['codex','claude']) writeFileSync(join(bin,cmd),`#!${process.execPath}\nconsole.log('fixture help/version');\n`,{mode:0o700});
  env.SEATWIRE_CODEX=join(bin,'codex');env.PATH=bin;
  const sent=cli('send','--to','receiver','not notified yet');
  assert.equal(sent.worker.state,'recent');assert.equal(sent.notification,'pending');
  assert.match(sent.detail,/does not prove notification acceptance, inbox retrieval or ack/);
  const before=snapshot(store), status=cli('status'),doctor=cli('doctor');
  assert.deepEqual(doctor.worker,status.worker);
  assert.equal(status.agents.find(r=>r.name==='receiver').notification.state,'pending');
  assert.equal(store.inbox('test','receiver')[0].read_at,null);
  assert.deepEqual(snapshot(store),before);
});
