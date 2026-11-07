import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { projectPath } from './context.mjs';
import { name, alive, pidNamespace, sharedCodexProcess } from './identity.mjs';
export function statePath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
  if (!isAbsolute(base)) throw Error('XDG_STATE_HOME must be absolute');
  return join(base, 'seatwire');
}
function privatePath(path, directory) {
  const s = lstatSync(path);
  if (s.uid !== process.getuid() || (s.mode & 0o077) || !(directory ? s.isDirectory() : s.isFile())) throw Error(`unsafe state permissions/type: ${path}`);
}
// A sandbox write denial otherwise surfaces as ENOENT from recursive mkdir or a generic SQLite error.
const SANDBOX_HINT = 'seatwire never changes sandbox settings; see README for granting access';
function denied(message, cause) { return Object.assign(Error(message), { cause }); }
// SQLITE_PERM, SQLITE_READONLY and SQLITE_CANTOPEN, including their extended codes.
const sqliteAccessError = e => e?.code === 'ERR_SQLITE_ERROR' && [3, 8, 14].includes(e.errcode & 0xff);
export class Store {
  constructor(dir = statePath()) {
    process.umask(0o077);
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
      if (existsSync(dir)) throw e;
      throw denied(`cannot create state directory ${dir}: ${e.message}. If this runs in an agent sandbox, create it on the host first (for example with seatwire status) and allow the sandbox to write it; ${SANDBOX_HINT}`, e);
    }
    privatePath(dir, true);
    this.path = join(dir, 'messages.sqlite3');
    for (const suffix of ['', '-wal', '-shm']) {
      try { privatePath(this.path + suffix, false); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    try { this.open(); } catch (e) {
      try { this.db?.close(); } catch { /* The original error explains the failure. */ }
      if (!sqliteAccessError(e)) throw e;
      throw denied(`cannot write state database ${this.path}: ${e.message}. If this runs in an agent sandbox, allow it to write ${dir}; ${SANDBOX_HINT}`, e);
    }
  }
  open() {
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA busy_timeout=5000');
    this.tx(() => {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2].includes(version)) throw Error(`unsupported schema ${version}; restore compatible binary or backup`);
      if (!version) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw Error('unversioned database is not empty');
        this.db.exec(`
          CREATE TABLE agents(team TEXT, name TEXT, kind TEXT NOT NULL, target TEXT, generation TEXT,
            notified INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
            retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, error TEXT,
            PRIMARY KEY(team,name));
          CREATE TABLE launches(team TEXT, name TEXT, record TEXT NOT NULL, PRIMARY KEY(team,name));
          CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL,
            sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
            created INTEGER NOT NULL, read_at INTEGER);
          CREATE INDEX inbox ON messages(team,recipient,id);
          PRAGMA user_version=1;
        `);
      }
      if (version < 2) this.db.exec(`
        CREATE TABLE pending_registrations(launch_id TEXT PRIMARY KEY, team TEXT NOT NULL,
          name TEXT NOT NULL, payload TEXT NOT NULL, error TEXT, created INTEGER NOT NULL);
        PRAGMA user_version=2;
      `);
    });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  register(team, who, kind, target = null, expected = null) {
    name(team); name(who);
    if (!['codex','claude-code'].includes(kind)) throw Error('unknown agent kind');
    return this.tx(() => {
      if (expected) {
        const launch = this.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(team,who);
        const request = this.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(target.launchId);
        if (launch && JSON.parse(launch.record).registrationRevoked) throw Error('launch registration revoked');
        if (launch?.record !== expected.record || request?.payload !== expected.payload) throw Error('registration request changed');
      }
      const old = this.db.prepare('SELECT * FROM agents WHERE team=? AND name=?').get(team,who);
      const previous = old?.target && JSON.parse(old.target);
      if (previous && alive(previous) && (!target || previous.witness !== target.witness || previous.session !== target.session)) throw Error('agent name owned by live session');
      if (target && this.db.prepare('SELECT name FROM agents WHERE team=? AND name<>? AND json_extract(target,\'$.session\')=?').get(team,who,target.session)) throw Error('session already assigned to another name');
      if (target && old?.kind === kind && old.target === JSON.stringify(target)) {
        if (expected) this.db.prepare('DELETE FROM pending_registrations WHERE launch_id=?').run(target.launchId);
        return;
      }
      this.db.prepare(`INSERT INTO agents(team,name,kind,target,generation) VALUES(?,?,?,?,?)
        ON CONFLICT(team,name) DO UPDATE SET kind=excluded.kind,target=excluded.target,generation=excluded.generation,
        notified=0,lease=NULL,lease_until=0,retry_at=0,failures=0,error=NULL`).run(team,who,kind,target ? JSON.stringify(target) : null,randomUUID());
      if (expected) this.db.prepare('DELETE FROM pending_registrations WHERE launch_id=?').run(target.launchId);
      if (kind === 'claude-code' && target?.socket) this.supersede(team,who,target);
    });
  }
  // A Claude process keeps one messaging socket across /clear, so the latest session owns it.
  // Earlier sessions keep their mailboxes but are no longer nudged into the new conversation.
  supersede(team, who, target) {
    const stale = this.db.prepare(`SELECT team,name FROM agents WHERE kind='claude-code' AND NOT (team=? AND name=?)
      AND json_extract(target,'$.socket')=? AND json_extract(target,'$.socketWitness')=?
      AND json_extract(target,'$.witness')=? AND json_extract(target,'$.session')<>?`)
      .all(team,who,target.socket,target.socketWitness,target.witness,target.session);
    for (const row of stale) {
      this.db.prepare('UPDATE agents SET target=NULL,generation=?,lease=NULL,lease_until=0,retry_at=0,failures=0,error=? WHERE team=? AND name=?')
        .run(randomUUID(),`session replaced in its Claude process by ${who}@${team}; messages kept until it is resumed`,row.team,row.name);
    }
  }
  send(team, from, to, body) {
    name(team); name(from); name(to);
    if (!body || Buffer.byteLength(body)>1048576) throw Error('message must be 1..1048576 bytes');
    return this.tx(() => {
      for (const who of [from,to]) if (!this.db.prepare('SELECT 1 FROM agents WHERE team=? AND name=?').get(team,who)) throw Error(`unregistered agent: ${who}`);
      return Number(this.db.prepare('INSERT INTO messages(team,sender,recipient,body,created) VALUES(?,?,?,?,?)').run(team,from,to,body,Date.now()).lastInsertRowid);
    });
  }
  reply(team, who, id, body) {
    name(team); name(who);
    if (!Number.isSafeInteger(id) || id < 1) throw Error('reply requires a received message ID');
    const message = this.db.prepare('SELECT sender FROM messages WHERE team=? AND recipient=? AND id=?').get(team,who,id);
    if (!message) throw Error('message not received by this agent');
    return {id:this.send(team,who,message.sender,body),to:message.sender};
  }
  // What the sender can know is whether the host will try to notify, never that the recipient processed it.
  delivery(team, who) {
    const row = this.db.prepare('SELECT target,error FROM agents WHERE team=? AND name=?').get(team,who);
    if (!row?.target) return {notification:'none',detail:'recipient has no registered session, so no notification is sent; the message stays unread until the recipient checks its inbox'};
    const online = this.targetOnline(team,who,JSON.parse(row.target));
    if (online === false) return {notification:'recipient not running',detail:'the registered session has exited; it is notified only after it registers again, for example when resumed'};
    if (row.error) return {notification:'failing',error:row.error,detail:'recent notifications to this recipient failed; the host notification worker retries with backoff'};
    return {notification:'pending',online,detail:'the host notification worker asks the recipient to check its inbox; only ack shows that it processed the message'};
  }
  peers(team, project, all = false) {
    name(team);
    return this.db.prepare('SELECT team,name,kind,target,error FROM agents WHERE team=? ORDER BY name').all(team)
      .map(({target,...row}) => {
        const t = target && JSON.parse(target);
        return {...row, project:t?.project || null, online:t ? this.targetOnline(row.team,row.name,t) : false};
      }).filter(row => all || (row.online !== false && row.project && projectPath(row.project) === projectPath(project)));
  }
  inbox(team, who, history=false) {
    name(team); name(who);
    return this.db.prepare(history ? 'SELECT * FROM messages WHERE team=? AND (recipient=? OR sender=?) ORDER BY id' : 'SELECT * FROM messages WHERE team=? AND recipient=? AND read_at IS NULL ORDER BY id').all(...(history ? [team,who,who] : [team,who]));
  }
  ack(team, who, ids) {
    name(team); name(who);
    if (!ids.length || ids.some(x=> !Number.isSafeInteger(x)||x<1)) throw Error('ack requires explicit message IDs');
    return this.tx(() => ids.reduce((n,id)=>n+Number(this.db.prepare('UPDATE messages SET read_at=? WHERE team=? AND recipient=? AND id=? AND read_at IS NULL').run(Date.now(),team,who,id).changes),0));
  }
  claim() {
    return this.tx(() => {
      const row = this.db.prepare(`SELECT a.*, (SELECT max(id) FROM messages m WHERE m.team=a.team AND m.recipient=a.name AND read_at IS NULL) AS upto
        FROM agents a WHERE target IS NOT NULL AND lease_until<? AND retry_at<? AND upto>notified LIMIT 1`).get(Date.now(),Date.now());
      if (!row) return null;
      row.lease = randomUUID();
      this.db.prepare('UPDATE agents SET lease=?,lease_until=? WHERE team=? AND name=?').run(row.lease,Date.now()+30000,row.team,row.name);
      return row;
    });
  }
  finish(row, error) {
    this.db.prepare(`UPDATE agents SET notified=CASE WHEN ? IS NULL THEN ? ELSE notified END,
      failures=CASE WHEN ? IS NULL THEN 0 ELSE failures+1 END,error=?,retry_at=?,lease=NULL,lease_until=0
      WHERE team=? AND name=? AND generation=? AND lease=?`).run(error,row.upto,error,error,error?Date.now()+Math.min(60000,1000*2**Math.min(row.failures,6)):0,row.team,row.name,row.generation,row.lease);
  }
  retry(team, who) {
    name(team); name(who);
    return this.tx(() => {
      const row=this.db.prepare('SELECT * FROM agents WHERE team=? AND name=?').get(team,who);
      if (!row) throw Error('unregistered agent');
      if (!row.target) throw Error('no notification target; register the session first');
      if (row.lease && row.lease_until > Date.now()) throw Error('notification in progress; retry after its lease expires');
      this.db.prepare('UPDATE agents SET notified=0,retry_at=0,failures=0,error=NULL,lease=NULL,lease_until=0,generation=? WHERE team=? AND name=?')
        .run(randomUUID(),team,who);
      return {team,name:who,state:'notification retry scheduled; unread messages unchanged'};
    });
  }
  targetOnline(team, who, target) {
    if (target.pidNamespace && target.pidNamespace !== pidNamespace()) return null;
    if (!this.targetAlive(team,who,target)) return false;
    return sharedCodexProcess(target.pid) === false ? true : null;
  }
  targetAlive(team, who, target) {
    if (!alive(target)) return false;
    if (!target.launchId) return true;
    const row = this.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get(team,who);
    if (!row) return false;
    const launch = JSON.parse(row.record);
    return !launch.registrationRevoked && launch.id === target.launchId && launch.phase === 'running' && alive(launch)
      && launch.agent?.witness === target.witness && launch.agent?.pid === target.pid;
  }
  status() {
    return this.db.prepare('SELECT team,name,kind,target,error,notified,failures,retry_at,lease_until,(SELECT count(*) FROM messages m WHERE m.team=agents.team AND m.recipient=agents.name AND read_at IS NULL) AS unread,(SELECT count(*) FROM messages m WHERE m.team=agents.team AND m.recipient=agents.name AND read_at IS NULL AND id<=agents.notified) AS acceptedUnread FROM agents').all().map(({target,acceptedUnread,...r})=>{
      const online=target?this.targetOnline(r.team,r.name,JSON.parse(target)):false;
      const pendingUnread=r.unread-acceptedUnread;
      const state=!r.unread?'idle':!target?'no-target':online===false?'offline':!pendingUnread?'accepted-unacknowledged':r.lease_until>Date.now()?'in-flight':r.error?'failed':'pending';
      return {...r,online,notification:{state,acceptedUnread,pendingUnread}};
    });
  }
  close(){ this.db.close(); }
}
