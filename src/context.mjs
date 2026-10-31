import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ancestor, witness } from './identity.mjs';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function sessionId(kind, input = {}, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('expected hook object');
  if (input.hook_event_name && input.hook_event_name !== 'SessionStart') throw Error('expected SessionStart');
  if (!['codex', 'claude-code'].includes(kind)) throw Error('unknown agent kind');
  const supplied = kind === 'codex' ? env.CODEX_THREAD_ID : env.CLAUDE_SESSION_ID;
  const session = input.session_id || supplied;
  if (typeof session !== 'string' || !UUID.test(session)) throw Error('missing authoritative session UUID');
  if (supplied && supplied !== session) throw Error('conflicting session IDs');
  return session;
}
export function automaticName(kind, session) {
  sessionId(kind, {session_id: session}, {});
  return `${kind}-${session}`;
}
export function projectPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
// Resolve only authoritative session metadata, never a recent transcript or cwd alone.
export function currentIdentity(store, {team, who, env = process.env, required = true} = {}) {
  if (who) return {team: team || 'default', name: who};
  const sessions = [env.CODEX_THREAD_ID, env.CLAUDE_SESSION_ID].filter(Boolean);
  if (sessions.some(id => !UUID.test(id))) throw Error('invalid session UUID in environment');
  let candidates = store.db.prepare('SELECT team,name,kind,target FROM agents WHERE target IS NOT NULL').all()
    .filter(row => !team || row.team === team);
  if (sessions.length) candidates = candidates.filter(row => sessions.includes(JSON.parse(row.target).session));
  else {
    const witnesses = new Map();
    for (const kind of ['codex', 'claude-code']) {
      try { witnesses.set(kind, witness(ancestor(kind))); } catch { /* No recognizable ancestor. */ }
    }
    candidates = candidates.filter(row => witnesses.get(row.kind) === JSON.parse(row.target).witness);
  }
  // Mailbox access uses the authoritative UUID even when host PIDs are hidden.
  // Delivery liveness remains the host notification worker's responsibility.
  if (!sessions.length) candidates = candidates.filter(row => store.targetAlive(row.team, row.name, JSON.parse(row.target)));
  if (!candidates.length && !required) return null;
  if (candidates.length !== 1) throw Error(candidates.length
    ? 'ambiguous session identity; select --team and --name'
    : 'session is not registered; enable the SessionStart hook or run actas --kind KIND; offline use requires --name');
  return {team: candidates[0].team, name: candidates[0].name};
}
