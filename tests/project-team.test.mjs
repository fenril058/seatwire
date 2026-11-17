import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { witness } from '../src/identity.mjs';

const cli=resolve('src/cli.mjs');
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sw-project-team-'));
  const config=join(dir,'config'); mkdirSync(join(config,'seatwire'),{recursive:true});
  const repo=join(dir,'main'),worktree=join(dir,'trial');
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const git=(...args)=>{
    const r=spawnSync('git',args,{env,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  git('init','--quiet',repo);
  git('-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','fixture');
  git('-C',repo,'worktree','add','--quiet','-b','trial',worktree);
  const state=join(dir,'state'),store=new Store(join(state,'seatwire'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const map=projects=>writeFileSync(join(config,'seatwire/projects.json'),JSON.stringify({version:1,projects}),{mode:0o600});
  const hook=(session,{cwd=worktree,source='startup',args=[],extraEnv={},input={}}={})=>{
    // A Node stand-in supplies process ancestry; no agent binary or production state is used.
    const script=`import {spawnSync} from 'node:child_process';
      const r=spawnSync(process.execPath,${JSON.stringify([cli,'hook','--kind','codex',...args])},{input:${JSON.stringify(JSON.stringify({session_id:session,cwd,source,...input}))},encoding:'utf8',timeout:5000});
      process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;`;
    return spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repo,argv0:'codex',encoding:'utf8',timeout:10000,env:{...process.env,XDG_STATE_HOME:state,XDG_CONFIG_HOME:config,SEATWIRE_TEAM:'',SEATWIRE_NAME:'',SEATWIRE_LAUNCH_ID:'',CODEX_THREAD_ID:session,CLAUDE_SESSION_ID:'',CLAUDE_CODE_SESSION_ID:'',...extraEnv}});
  };
  const rows=()=>store.db.prepare('SELECT * FROM agents ORDER BY team,name').all();
  const target=session=>({session,pid:process.pid,witness:witness(process.pid),project:worktree});
  return {dir,config,repo,worktree,state,store,map,hook,rows,target,git};
}

test('project Hook registers in the configured worktree team, not the parent checkout',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'trial'});
  const r=f.hook(session);assert.equal(r.status,0,r.stderr);
  assert.deepEqual(f.rows().map(x=>[x.team,x.name]),[['trial',`codex-${session}`]]);
  assert.equal(JSON.parse(f.rows()[0].target).project,f.worktree);
  const normal=randomUUID();assert.equal(f.hook(normal,{cwd:f.repo}).status,0);
  assert.equal(f.rows().find(x=>x.name===`codex-${normal}`).team,'default');
});

test('resume retains the existing custom identity after project settings change',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'new-team'});
  f.store.register('original','reviewer','codex',{...f.target(session),witness:'expired'});
  const r=f.hook(session,{source:'resume'});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(f.rows().map(x=>[x.team,x.name]),[['original','reviewer']]);
});

test('released resume is refused without creating a guessed mailbox',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'trial'});
  f.store.register('original','custom-role','codex',f.target(session));
  f.store.db.prepare('UPDATE agents SET target=NULL').run();
  const before=f.rows();const r=f.hook(session,{source:'resume'});
  assert.deepEqual(f.rows(),before);
  assert.equal(r.status,1);assert.match(r.stderr,/resume|identity/);
});

test('registration refuses the same UUID in another team',t=>{
  const f=fixture(t),session=randomUUID();f.store.register('original','reviewer','codex',f.target(session));
  try {f.store.register('other','reviewer','codex',f.target(session));} catch {}
  assert.deepEqual(f.rows().map(x=>x.team),['original']);
});

test('conflicting Hook environment and project team leave registration unchanged',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});const r=f.hook(randomUUID(),{extraEnv:{SEATWIRE_TEAM:'ambient'}});
  assert.equal(f.rows().length,0);assert.equal(r.status,1);assert.match(r.stderr,/conflict/);
});

test('an explicit initial team and name retain precedence over environment and mapping',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});
  const r=f.hook(randomUUID(),{args:['--team','manual','--name','reviewer'],extraEnv:{SEATWIRE_TEAM:'ambient'}});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(f.rows().map(x=>[x.team,x.name]),[['manual','reviewer']]);
});

test('an explicit team cannot move a registered UUID',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'trial'});f.store.register('original','reviewer','codex',{...f.target(session),witness:'expired'});
  const before=f.rows(),r=f.hook(session,{source:'resume',args:['--team','other']});
  assert.deepEqual(f.rows(),before);assert.equal(r.status,1);assert.match(r.stderr,/conflict/);
});

test('legacy UUID duplicates are refused even with an explicit team',t=>{
  const f=fixture(t),session=randomUUID();f.store.register('original','reviewer','codex',f.target(session));
  f.store.db.prepare("INSERT INTO agents SELECT 'other',name,kind,target,generation,notified,lease,lease_until,retry_at,failures,error FROM agents").run();
  const before=f.rows(),r=f.hook(session,{source:'resume',args:['--team','original']});
  assert.deepEqual(f.rows(),before);assert.equal(r.status,1);assert.match(r.stderr,/ambiguous/);
});

test('Git root lookup uses the Hook worktree subdirectory and ignores inherited GIT_DIR',t=>{
  const f=fixture(t),sub=join(f.worktree,'sub');mkdirSync(sub);f.map({[f.worktree]:'trial'});
  const r=f.hook(randomUUID(),{cwd:sub,extraEnv:{GIT_DIR:join(f.repo,'.git'),GIT_WORK_TREE:f.repo}});
  assert.equal(r.status,0,r.stderr);assert.equal(f.rows()[0].team,'trial');
  assert.equal(JSON.parse(f.rows()[0].target).project,sub);
});

test('a released automatic mailbox is not rebound even with startup metadata',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'trial'});f.store.register('original',`codex-${session}`,'codex');
  const before=f.rows(),r=f.hook(session);assert.deepEqual(f.rows(),before);assert.equal(r.status,1);
});

test('an identical resumed target preserves generation, progress, lease and unread data',t=>{
  const f=fixture(t),session=randomUUID(),target=f.target(session);
  f.store.register('original','reviewer','codex',target);f.store.register('original','sender','claude-code');
  f.store.send('original','sender','reviewer','retained');f.store.claim();
  const before=f.rows(),messages=f.store.inbox('original','reviewer',true);
  const identity=f.store.registerSession('codex',target,{source:'resume',project:{team:'new-team'}});
  assert.deepEqual(identity,{team:'original',name:'reviewer'});assert.deepEqual(f.rows(),before);
  assert.deepEqual(f.store.inbox('original','reviewer',true),messages);
});

test('unconfigured worktrees retain source-free and resume compatibility even with another project configured',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});
  for(const source of [undefined,'resume','compact','legacy-source']) {
    const session=randomUUID(),r=f.hook(session,{cwd:f.repo,input:{source}});
    assert.equal(r.status,0,r.stderr);
    assert.equal(f.rows().find(x=>x.name===`codex-${session}`).team,'default');
  }
});

test('configured worktrees reject unknown sources, including explicit identities and existing UUIDs',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});
  const registered=randomUUID();f.store.register('original','reviewer','codex',f.target(registered));
  const before=f.rows();
  for(const session of [registered,randomUUID()]) for(const source of [undefined,'legacy-source']) {
    const r=f.hook(session,{input:{source},args:['--team','original','--name','reviewer']});
    assert.deepEqual(f.rows(),before);assert.equal(r.status,1);assert.match(r.stderr,/source/);
  }
});

test('startup, clear and fork can create fresh configured identities',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});
  for(const source of ['startup','clear','fork']) {
    const session=randomUUID(),r=f.hook(session,{source});assert.equal(r.status,0,r.stderr);
    assert.equal(f.rows().find(x=>x.name===`codex-${session}`).team,'trial');
  }
});

test('resume and compact require an existing UUID in configured worktrees',t=>{
  const f=fixture(t);f.map({[f.worktree]:'trial'});
  for(const source of ['resume','compact']) {
    const session=randomUUID();f.store.register('original',`custom-${source}`,'codex',f.target(session));
    f.store.db.prepare('UPDATE agents SET target=NULL WHERE name=?').run(`custom-${source}`);
    const before=f.rows(),r=f.hook(session,{source,args:['--team','original','--name',`custom-${source}`]});
    assert.deepEqual(f.rows(),before);assert.equal(r.status,1);assert.match(r.stderr,/restore/);
  }
});

test('compact preserves identity even when the worktree now selects another team',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'new-team'});
  f.store.register('original','reviewer','codex',{...f.target(session),witness:'expired'});
  const r=f.hook(session,{source:'compact'});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(f.rows().map(x=>[x.team,x.name]),[['original','reviewer']]);
});

test('legacy unconfigured path cannot recover a cleared custom UUID association',t=>{
  const f=fixture(t),session=randomUUID();f.map({[f.worktree]:'trial'});
  f.store.register('original','custom','codex',f.target(session));
  f.store.db.prepare('UPDATE agents SET target=NULL').run();
  const old=f.rows()[0],r=f.hook(session,{cwd:f.repo,input:{source:undefined}});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(f.rows().find(x=>x.name==='custom'),old);
  assert.equal(f.rows().find(x=>x.name===`codex-${session}`).team,'default');
});

test('invalid project settings are diagnosed without changing the database',t=>{
  const f=fixture(t),file=join(f.config,'seatwire/projects.json');
  for(const contents of ['{',JSON.stringify({version:1,projects:{[f.worktree]:['trial']}}),' '.repeat(65537)]) {
    writeFileSync(file,contents,{mode:0o600});const r=f.hook(randomUUID());
    assert.equal(r.status,1);assert.equal(f.rows().length,0);
  }
  f.map({[f.worktree]:'trial'});chmodSync(file,0o666);
  const r=f.hook(randomUUID());assert.equal(r.status,1);assert.equal(f.rows().length,0);assert.match(r.stderr,/permissions/);
});

test('canonical root aliases are rejected and non-Git directories stay unconfigured',t=>{
  const f=fixture(t),alias=join(f.dir,'alias');symlinkSync(f.worktree,alias);
  f.map({[f.worktree]:'trial',[alias]:'other'});
  assert.equal(f.hook(randomUUID()).status,1);assert.equal(f.rows().length,0);
  f.map({[f.worktree]:'trial'});const outside=join(f.dir,'outside');mkdirSync(outside);
  const session=randomUUID(),r=f.hook(session,{cwd:outside,input:{source:undefined}});
  assert.equal(r.status,0,r.stderr);assert.equal(f.rows()[0].team,'default');
});

test('Git is not required without settings, but failed observation never chooses default',t=>{
  const f=fixture(t),session=randomUUID();
  const legacy=f.hook(session,{input:{source:undefined},extraEnv:{PATH:'/nonexistent'}});
  assert.equal(legacy.status,0,legacy.stderr);assert.equal(f.rows()[0].team,'default');
  f.map({[f.worktree]:'trial'});const before=f.rows();
  const failed=f.hook(randomUUID(),{extraEnv:{PATH:'/nonexistent'}});
  assert.equal(failed.status,1);assert.match(failed.stderr,/observe/);assert.deepEqual(f.rows(),before);
});

test('worktree root observation preserves spaces in directory names',t=>{
  const f=fixture(t),spaced=join(f.dir,'trial space ');
  f.git('-C',f.repo,'worktree','add','--quiet','-b','spaced',spaced);f.map({[spaced]:'trial'});
  const r=f.hook(randomUUID(),{cwd:spaced});assert.equal(r.status,0,r.stderr);
  assert.equal(f.rows()[0].team,'trial');assert.equal(JSON.parse(f.rows()[0].target).project,spaced);
});
