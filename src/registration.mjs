import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { name, alive, socketWitness, pidNamespace } from './identity.mjs';
import { readLaunch, observeServer, registrationDetail } from './spawn.mjs';

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
  let rejected;
  store.tx(() => {
    const launch = readLaunch(store, team, who);
    if (!launch || launch.id !== launchId || launch.kind !== kind || !['launching','running'].includes(launch.phase)) throw Error('stale or mismatched launch');
    if (launch.project && resolve(launch.project) !== resolve(payload.project)) throw Error('session project mismatch');
    const old = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team, who);
    const target = old?.target && JSON.parse(old.target);
    if (launch.registrationRevoked) throw Error('launch registration revoked; explicitly stop this launch and resume in a new managed launch');
    const pending = store.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(launchId);
    const sessions = [launch.mailboxSession, target?.launchId === launchId ? target.session : null,
      pending && JSON.parse(pending.payload).session].filter(Boolean);
    // Pending requests bind the conversation before host validation publishes a target.
    // Commit revocation before reporting rejection; throwing inside tx would undo it.
    if (sessions.some(session => session !== payload.session)) {
      launch.registrationRevoked = true;
      store.db.prepare('UPDATE launches SET record=? WHERE team=? AND name=?').run(JSON.stringify(launch),team,who);
      store.db.prepare('UPDATE agents SET target=NULL,generation=?,lease=NULL,lease_until=0,error=? WHERE team=? AND name=?')
        .run(randomUUID(),'launch registration revoked after session UUID change; explicitly stop and resume in a new managed launch',team,who);
      store.db.prepare('DELETE FROM pending_registrations WHERE launch_id=?').run(launchId);
      rejected = 'launch registration revoked after session UUID change; explicitly stop and resume in a new managed launch; unread mailbox retained';
      return;
    }
    if (!launch.mailboxSession) {
      launch.mailboxSession = payload.session;
      store.db.prepare('UPDATE launches SET record=? WHERE team=? AND name=?').run(JSON.stringify(launch),team,who);
    }
    if (target?.launchId === launchId) return; // Duplicate SessionStart preserves progress.
    store.db.prepare(`INSERT INTO pending_registrations(launch_id,team,name,payload,created) VALUES(?,?,?,?,?)
      ON CONFLICT(launch_id) DO UPDATE SET payload=excluded.payload,error=NULL,created=excluded.created`)
      .run(launchId,team,who,encoded,Date.now());
  });
  if (rejected) throw Error(rejected);
}
export function reconcileRegistrations(store) {
  const requests = store.db.prepare('SELECT * FROM pending_registrations WHERE error IS NULL ORDER BY created LIMIT 100').all();
  for (const request of requests) {
    try {
      const row = store.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(request.team,request.name);
      const launch = row && JSON.parse(row.record);
      if (!launch || launch.id !== request.launch_id) throw Error('launch reservation changed');
      if (launch.registrationRevoked) throw Error('launch registration revoked');
      if (launch.phase === 'launching' && alive(launch.starter)) continue;
      if (launch.phase !== 'running' || !alive(launch) || !launch.agent || !alive(launch.agent)) throw Error('managed agent is not running');
      observeServer(launch); // External I/O stays outside SQLite transactions.
      const payload = JSON.parse(request.payload);
      if (resolve(payload.project) !== resolve(launch.project)) throw Error('session project mismatch');
      const target = { ...payload, ...launch.agent, pidNamespace:pidNamespace(), launchId: launch.id };
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
  let lastDetail = 'not-observed';
  while (Date.now() < deadline) {
    reconcileRegistrations(store);
    const launch = readLaunch(store,team,who);
    if (!launch || launch.id !== launchId) throw Error('launch changed while waiting');
    if (launch.registrationRevoked) throw Error('launch registration revoked; explicitly stop and resume in a new managed launch');
    const row = store.db.prepare('SELECT target FROM agents WHERE team=? AND name=?').get(team,who);
    const target = row?.target && JSON.parse(row.target);
    if (target?.launchId === launchId && store.targetAlive(team,who,target)) return;
    const request = store.db.prepare('SELECT error FROM pending_registrations WHERE launch_id=?').get(launchId);
    lastDetail = registrationDetail('pending',request,!!(launch.mailboxSession || (target && target.launchId === launchId)));
    if (request?.error) throw Error(`registration failed: ${request.error}`);
    if (launch.agent && !alive(launch.agent)) throw Error('agent exited before registration');
    await new Promise(r=>setTimeout(r,100));
  }
  const guidance = lastDetail === 'request-not-received'
    ? 'No SessionStart request was observed. Check whether the first turn has started, SessionStart hook installation/trust, and the hook environment (SEATWIRE_LAUNCH_ID, SEATWIRE_TEAM, SEATWIRE_NAME and selected state-home).'
    : lastDetail === 'awaiting-host-validation'
      ? 'A request was received. Check the launch phase, process identity and registration errors in status; this wait performs host validation itself.'
      : lastDetail === 'session-observed'
        ? 'Session metadata was recorded, but no request is pending and readiness was not confirmed. Inspect status and the recorded process identity.'
        : 'No registration check completed before timeout; inspect status.';
  throw Error(`registration timed out; launched agent retained; last observed registration: ${lastDetail}. ${guidance}`);
}
