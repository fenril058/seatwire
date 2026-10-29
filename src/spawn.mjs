import { spawnSync } from 'node:child_process';
import { mkdirSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { name, alive, witness, socketWitness } from './identity.mjs';
import { statePath } from './store.mjs';
function tmux(socket,args) {
  const r=spawnSync('tmux',['-S',socket,...args],{encoding:'utf8',timeout:10000});
  if(r.error || r.status!==0) throw Error(r.error?.message || r.stderr.trim() || 'tmux failed');
  return r.stdout.trim();
}
const quote=s=>`'${String(s).replaceAll("'", "'\\''")}'`;
export function launch(store,team,who,kind,{prompt='',resume='',cli}) {
  name(team);name(who);
  if(!['codex','claude-code'].includes(kind)) throw Error('unknown agent kind');
  if(resume && !/^[a-f0-9-]{36}$/i.test(resume)) throw Error('resume requires exact session UUID');
  const base=process.env.XDG_RUNTIME_DIR || statePath();
  if(!isAbsolute(base)) throw Error('runtime directory must be absolute');
  const dir=join(base,'seatwire-tmux');mkdirSync(dir,{recursive:true,mode:0o700});
  const st=lstatSync(dir);if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077)) throw Error('unsafe runtime directory');
  const socket=join(dir,randomUUID().slice(0,16));if(Buffer.byteLength(socket)>100) throw Error('tmux socket path too long');
  return store.tx(()=>{
    if(store.db.prepare('SELECT 1 FROM launches WHERE team=? AND name=?').get(team,who)) throw Error('managed launch already exists; despawn it first');
    const existing=store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team,who);
    if(existing?.target && alive(JSON.parse(existing.target))) throw Error('agent name owned by live session');
    store.db.prepare('INSERT INTO agents(team,name,kind,generation) VALUES(?,?,?,?) ON CONFLICT(team,name) DO NOTHING').run(team,who,kind,randomUUID());
    const hook={matcher:'*',hooks:[{type:'command',command:`${quote(process.execPath)} ${quote(cli)} --team ${team} --name ${who} hook --kind ${kind}`}]};
    const args=kind==='codex'
      ? [process.env.SEATWIRE_CODEX || 'codex','-c',`hooks.SessionStart=${`[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hook.hooks[0].command)}}]}]`}`,...(resume?['resume',resume]:[])]
      : ['claude','--settings',JSON.stringify({hooks:{SessionStart:[hook]}}),...(resume?['--resume',resume]:[])];
    if(prompt) args.push(prompt);
    const env=['env',`SEATWIRE_TEAM=${team}`,`SEATWIRE_NAME=${who}`,`XDG_STATE_HOME=${process.env.XDG_STATE_HOME || join(process.env.HOME,'.local/state')}`];
    try {
      tmux(socket,['-f','/dev/null','new-session','-d','-s','agent',[...env,...args].map(quote).join(' ')]);
      const pid=Number(tmux(socket,['display-message','-p','#{pid}']));
      const record={socket,socketWitness:socketWitness(socket),pid,witness:witness(pid),kind};
      store.db.prepare('INSERT INTO launches(team,name,record) VALUES(?,?,?)').run(team,who,JSON.stringify(record));
      return {team,name:who,socket,attach:`tmux -S ${quote(socket)} attach -t agent`,registration:'pending SessionStart (Codex hook trust review may be required)'};
    } catch(e) {
      // Only this invocation's randomly allocated server may be cleaned up.
      try {tmux(socket,['kill-server']);} catch {}
      throw e;
    }
  });
}
export function despawn(store,team,who,force) {
  name(team);name(who);
  return store.tx(()=>{
    const row=store.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(team,who);
    if(!row) throw Error('not a seatwire-managed launch');
    const r=JSON.parse(row.record);
    if(!alive(r)) {store.db.prepare('DELETE FROM launches WHERE team=? AND name=?').run(team,who);return {state:'already stopped'};}
    if(socketWitness(r.socket)!==r.socketWitness) throw Error('tmux socket replaced; refusing to stop');
    if(Number(tmux(r.socket,['display-message','-p','#{pid}']))!==r.pid) throw Error('tmux server changed');
    if(force) {
      tmux(r.socket,['kill-session','-t','=agent']);
      store.db.prepare('DELETE FROM launches WHERE team=? AND name=?').run(team,who);
      return {state:'forced stop requested'};
    }
    tmux(r.socket,['send-keys','-t','%0','C-c']);
    return {state:'interrupt requested; inspect/exit the agent normally, or explicitly use --force',socket:r.socket};
  });
}

export function launchStatus(store) {
  return store.db.prepare('SELECT team,name,record FROM launches').all().map(({record,...row})=>{
    const r=JSON.parse(record);
    return {...row,kind:r.kind,running:alive(r),socket:r.socket};
  });
}
