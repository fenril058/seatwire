import { isAbsolute, resolve } from 'node:path';
import { name, alive, socketWitness } from './identity.mjs';
import { readLaunch, observeServer } from './spawn.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw Error('invalid absolute path');
  return value;
}
// This path deliberately does not read /proc: the hook may run in a PID namespace.
export function submitRegistration(store, team, who, kind, launchId, input, env = process.env) {
  name(team); name(who);
  if (!UUID.test(launchId || '') || !UUID.test(input.session_id || '')) throw Error('invalid launch/session UUID');
  if (input.hook_event_name && input.hook_event_name !== 'SessionStart') throw Error('expected SessionStart');
  const payload = { session: input.session_id, project: absolute(input.cwd) };
  if (kind === 'claude-code') {
    payload.socket = absolute((env.CLAUDE_CODE_MESSAGING_SOCKET || '').replace(/^uds:/, ''));
    payload.token = env.CLAUDE_CODE_MESSAGING_TOKEN || '';
    if (!/^[A-Za-z0-9._-]*$/.test(payload.token)) throw Error('invalid messaging token');
    payload.transcript = input.transcript_path ? absolute(input.transcript_path) : '';
  }
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 65536) throw Error('registration too large');
  store.tx(() => {
    const launch = readLaunch(store, team, who);
    if (!launch || launch.id !== launchId || launch.kind !== kind || !['launching','running'].includes(launch.phase)) throw Error('stale or mismatched launch');
    if (launch.project && resolve(launch.project) !== resolve(payload.project)) throw Error('session project mismatch');
    const old = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team, who);
    const target = old?.target && JSON.parse(old.target);
    if (target?.launchId === launchId) {
      if (target.session !== payload.session) throw Error('live launch already bound to another session');
      return; // Duplicate SessionStart/compact does not reset notification progress.
    }
    const pending = store.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(launchId);
    if (pending && JSON.parse(pending.payload).session !== payload.session) throw Error('launch has a different pending session');
    store.db.prepare(`INSERT INTO pending_registrations(launch_id,team,name,payload,created) VALUES(?,?,?,?,?)
      ON CONFLICT(launch_id) DO UPDATE SET payload=excluded.payload,error=NULL,created=excluded.created`)
      .run(launchId,team,who,encoded,Date.now());
  });
}
export function reconcileRegistrations(store) {
  const requests = store.db.prepare('SELECT * FROM pending_registrations WHERE error IS NULL ORDER BY created LIMIT 100').all();
  for (const request of requests) {
    try {
      const row = store.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(request.team,request.name);
      const launch = row && JSON.parse(row.record);
      if (!launch || launch.id !== request.launch_id) throw Error('launch reservation changed');
      if (launch.phase === 'launching' && alive(launch.starter)) continue;
      if (launch.phase !== 'running' || !alive(launch) || !launch.agent || !alive(launch.agent)) throw Error('managed agent is not running');
      observeServer(launch); // External I/O stays outside SQLite transactions.
      const payload = JSON.parse(request.payload);
      if (resolve(payload.project) !== resolve(launch.project)) throw Error('session project mismatch');
      const target = { ...payload, ...launch.agent, launchId: launch.id };
      if (launch.kind === 'codex') target.home = absolute(launch.home);
      else target.socketWitness = socketWitness(target.socket);
      store.register(request.team,request.name,launch.kind,target,{record:row.record,payload:request.payload});
    } catch (error) {
      store.db.prepare('UPDATE pending_registrations SET error=? WHERE launch_id=? AND payload=?')
        .run(error.message,request.launch_id,request.payload);
    }
  }
}
export async function waitReady(store, team, who, launchId, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Error('ready timeout must be 1..300000 ms');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    reconcileRegistrations(store);
    const launch = readLaunch(store,team,who);
    if (!launch || launch.id !== launchId) throw Error('launch changed while waiting');
    const row = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team,who);
    const target = row?.target && JSON.parse(row.target);
    if (target?.launchId === launchId && store.targetAlive(team,who,target)) return;
    const request = store.db.prepare('SELECT error FROM pending_registrations WHERE launch_id=?').get(launchId);
    if (request?.error) throw Error(`registration failed: ${request.error}`);
    if (launch.agent && !alive(launch.agent)) throw Error('agent exited before registration');
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('registration timed out; launched agent retained (inspect status and hook trust)');
}
