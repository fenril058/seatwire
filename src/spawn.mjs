import { spawnSync } from 'node:child_process';
import { mkdirSync, lstatSync, existsSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { name, alive, witness, socketWitness } from './identity.mjs';

export function tmux(socket, args) {
  const r = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr.trim() || 'tmux failed');
  return r.stdout.trim();
}
export const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
export function readLaunch(store, team, who) {
  const row = store.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(team, who);
  return row ? JSON.parse(row.record) : null;
}
export function updateLaunch(store, team, who, id, record) {
  const result = store.db.prepare("UPDATE launches SET record=? WHERE team=? AND name=? AND json_extract(record,'$.id')=?")
    .run(JSON.stringify(record), team, who, id);
  if (!result.changes) throw Error('launch reservation changed');
}
function forget(store, team, who, record) {
  store.db.prepare('DELETE FROM launches WHERE team=? AND name=? AND record=?').run(team, who, JSON.stringify(record));
}
// The random ID is a generation marker, not authentication against this OS user.
export function observeServer(record) {
  const socketIdentity = socketWitness(record.socket);
  if (record.socketWitness && record.socketWitness !== socketIdentity) throw Error('tmux socket replaced; refusing operation');
  if (record.id && tmux(record.socket, ['show-options', '-gqv', '@seatwire-launch']) !== record.id) throw Error('tmux launch ID mismatch');
  const pid = Number(tmux(record.socket, ['display-message', '-p', '#{pid}']));
  const start = witness(pid);
  if (record.pid && (record.pid !== pid || record.witness !== start)) throw Error('tmux server changed');
  return { pid, witness: start, socketWitness: socketIdentity };
}
export function launch(store, team, who, kind, { prompt = '', resume = '', cli }) {
  name(team); name(who);
  if (!['codex', 'claude-code'].includes(kind)) throw Error('unknown agent kind');
  if (resume && !/^[a-f0-9-]{36}$/i.test(resume)) throw Error('resume requires exact session UUID');
  const base = process.env.XDG_RUNTIME_DIR || dirname(store.path);
  if (!isAbsolute(base)) throw Error('runtime directory must be absolute');
  const dir = join(base, 'seatwire-tmux');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('unsafe runtime directory');
  const id = randomUUID();
  const socket = join(dir, id.slice(0, 16));
  if (Buffer.byteLength(socket) > 100) throw Error('tmux socket path too long');
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  if (!isAbsolute(home)) throw Error('CODEX_HOME must be absolute');
  const reservation = { home, project: process.cwd(), id, phase: 'launching', socket, kind, created: Date.now(), starter: { pid: process.pid, witness: witness(process.pid) } };
  store.tx(() => {
    if (readLaunch(store, team, who)) throw Error('managed launch already exists; despawn it first');
    const existing = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team, who);
    if (existing?.target && alive(JSON.parse(existing.target))) throw Error('agent name owned by live session');
    store.db.prepare('INSERT INTO agents(team,name,kind,generation) VALUES(?,?,?,?) ON CONFLICT(team,name) DO NOTHING').run(team, who, kind, randomUUID());
    store.db.prepare('INSERT INTO launches(team,name,record) VALUES(?,?,?)').run(team, who, JSON.stringify(reservation));
  });
  const hook = { matcher: '*', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(cli)} --state-home ${quote(dirname(dirname(store.path)))} --team ${team} --name ${who} hook --kind ${kind} --launch-id ${id}` }] };
  const args = kind === 'codex'
    ? [process.env.SEATWIRE_CODEX || 'codex', '-c', `hooks.SessionStart=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hook.hooks[0].command)}}]}]`, ...(resume ? ['resume', resume] : [])]
    : ['claude', '--settings', JSON.stringify({ hooks: { SessionStart: [hook] } }), ...(resume ? ['--resume', resume] : [])];
  if (prompt) args.push(prompt);
  const env = ['env', `SEATWIRE_LAUNCH_ID=${id}`, `SEATWIRE_TEAM=${team}`, `SEATWIRE_NAME=${who}`, `XDG_STATE_HOME=${dirname(dirname(store.path))}`];
  try {
    tmux(socket, ['-f', '/dev/null', 'new-session', '-d', '-s', 'agent', 'exec ' + [...env, ...args].map(quote).join(' '), ';', 'set-option', '-g', '@seatwire-launch', id]);
    const agentPid = Number(tmux(socket, ['display-message', '-p', '-t', '%0', '#{pane_pid}']));
    const record = { ...reservation, ...observeServer(reservation), agent: { pid: agentPid, witness: witness(agentPid) }, phase: 'running' };
    updateLaunch(store, team, who, id, record);
    return { team, name: who, launchId: id, socket, attach: `tmux -S ${quote(socket)} attach -t agent`, registration: 'pending SessionStart (Codex hook trust review may be required)' };
  } catch (error) {
    // Keep ambiguous launches recoverable instead of deleting their only record.
    let cleaned = !existsSync(socket);
    if (!cleaned) {
      try { observeServer(reservation); tmux(socket, ['kill-session', '-t', '=agent']); cleaned = true; } catch {}
    }
    if (cleaned) forget(store, team, who, reservation);
    else updateLaunch(store, team, who, id, { ...reservation, phase: 'failed', error: error.message });
    throw error;
  }
}
export function despawn(store, team, who, force) {
  name(team); name(who);
  const record = readLaunch(store, team, who);
  if (!record) throw Error('not a seatwire-managed launch');
  if (record.phase === 'launching' && alive(record.starter)) throw Error('launch is still in progress');
  if ((record.pid && !alive(record)) || (!record.pid && !existsSync(record.socket))) {
    forget(store, team, who, record);
    return { state: 'already stopped' };
  }
  observeServer(record);
  if (force) {
    tmux(record.socket, ['kill-session', '-t', '=agent']);
    forget(store, team, who, record);
    return { state: 'forced stop requested' };
  }
  tmux(record.socket, ['send-keys', '-t', '%0', 'C-c']);
  return { state: 'interrupt requested; inspect/exit the agent normally, or explicitly use --force', socket: record.socket };
}
export function launchStatus(store) {
  return store.db.prepare('SELECT team,name,record FROM launches').all().map(({ record, ...row }) => {
    const r = JSON.parse(record);
    const pending = r.id && store.db.prepare('SELECT error FROM pending_registrations WHERE launch_id=?').get(r.id);
    const agent = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(row.team,row.name);
    const target = agent?.target && JSON.parse(agent.target);
    const ready = target?.launchId === r.id && store.targetAlive(row.team,row.name,target);
    return { ...row, kind: r.kind, phase: r.phase || 'running', running: alive(r), agentRunning: r.agent ? alive(r.agent) : null, registration: ready ? 'ready' : pending?.error ? 'failed' : 'pending', abandoned: r.phase === 'launching' && !alive(r.starter), socket: r.socket, error: r.error || pending?.error || null };
  });
}
