import { constants, mkdirSync, lstatSync, readFileSync, readlinkSync, openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { witness, pidNamespace } from './identity.mjs';

export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_STALE_MS = 30000;
export const MAX_WORKER_FILES = 128;
export const MAX_WORKER_BYTES = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const timestamp = n => Number.isSafeInteger(n) && n > 0;

function privateDirectory(dir) {
  const s = lstatSync(dir);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('unsafe-directory');
}

// Optional diagnostics must never stop notification work. Disable this reporter on
// failure, keeping at most one unfinished temporary file and warning once.
export function startWorker(state, { once=false, now=Date.now, warn=message=>console.error(message) } = {}) {
  const dir=join(state,'workers'), id=randomUUID();
  let record, disabled=false, lastAttempt=null;
  function update(force=false, stopped=false) {
    if (disabled) return;
    try {
      const time=now();
      if (!force && lastAttempt !== null && time >= lastAttempt && time-lastAttempt < HEARTBEAT_INTERVAL_MS) return;
      lastAttempt=time;
      if (!record) {
        try { mkdirSync(dir,{mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      privateDirectory(dir);
      record ||= {version:1,id,pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace(),mode:once?'once':'daemon',startedAt:time};
      const next={...record,updatedAt:time,stoppedAt:stopped?time:null};
      const temporary=join(dir,`.${id}.tmp`);
      const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { writeFileSync(fd,JSON.stringify(next)); } finally { closeSync(fd); }
      renameSync(temporary,join(dir,`${id}.json`));
    } catch { fail(); }
  }
  function fail() {
    disabled=true;
    try { warn('seatwire: worker diagnostics could not be recorded; notifications continue without heartbeat updates'); } catch { /* Logging is optional too. */ }
  }
  update(true);
  return { update:()=>update(), stop:()=>{update(true,true);disabled=true;} };
}

// Unlike alive(), preserve observation failures. Only compare numeric PIDs when
// this procfs exposes the caller's PID namespace and the record uses it too.
export function observeWorker(record, { readFile=readFileSync } = {}) {
  const namespace=pidNamespace();
  if (!namespace || record.pidNamespace !== namespace) return {online:null,reason:'pid-namespace-unavailable'};
  let boot;
  try {
    // NSpid starts in the procfs mount's namespace. More than one value means
    // this view uses an ancestor's PIDs, even if numeric PIDs happen to coincide.
    const pids=readFile('/proc/self/status','utf8').match(/^NSpid:\s*(.+)$/m)?.[1].trim().split(/\s+/);
    if (readlinkSync('/proc/self') !== String(process.pid) || pids?.length !== 1 || pids[0] !== String(process.pid)) return {online:null,reason:'proc-namespace-unavailable'};
    boot=readFile('/proc/sys/kernel/random/boot_id','utf8').trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) return {online:null,reason:'process-unobservable'};
  } catch { return {online:null,reason:'process-unobservable'}; }
  if (record.witness.split(':')[0] !== boot) return {online:false,reason:'boot-changed'};
  try {
    if (lstatSync(`/proc/${record.pid}`).uid !== process.getuid()) return {online:null,reason:'process-unobservable'};
    const fields=readFile(`/proc/${record.pid}/stat`,'utf8').split(') ').at(-1).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return {online:false,reason:'process-exited'};
    if (!/^\d+$/.test(fields[19] || '')) return {online:null,reason:'process-unobservable'};
    const online=`${boot}:${record.pid}:${fields[19]}` === record.witness;
    return {online,reason:online?'process-verified':'process-replaced'};
  } catch (e) {
    return e.code === 'ENOENT' ? {online:false,reason:'process-exited'} : {online:null,reason:'process-unobservable'};
  }
}

function readRecord(path, id, now, probe) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let record;
  try {
    const s=fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('unsafe-record');
    if (s.size > MAX_WORKER_BYTES) throw Error('record-too-large');
    const buffer=Buffer.alloc(MAX_WORKER_BYTES+1);
    const size=readSync(fd,buffer,0,buffer.length,0);
    if (size > MAX_WORKER_BYTES) throw Error('record-too-large');
    try { record=JSON.parse(buffer.subarray(0,size).toString('utf8')); } catch { throw Error('invalid-record'); }
  } finally { closeSync(fd); }
  const r=record;
  if (!r || r.version !== 1 || r.id !== id || !['daemon','once'].includes(r.mode)
    || !Number.isSafeInteger(r.pid) || r.pid < 2 || typeof r.witness !== 'string'
    || !new RegExp(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:${r.pid}:\\d+$`).test(r.witness)
    || !(r.pidNamespace === null || /^pid:\[\d+\]$/.test(r.pidNamespace))
    || !timestamp(r.startedAt) || !timestamp(r.updatedAt) || !(r.stoppedAt === null || timestamp(r.stoppedAt))) throw Error('invalid-record');
  const observed=probe(r);
  const state=r.stoppedAt !== null || observed.online === false ? 'stopped'
    : r.updatedAt > now || r.startedAt > r.updatedAt ? 'unknown'
    : now-r.updatedAt >= HEARTBEAT_STALE_MS ? 'stale' : 'recent';
  return {id,mode:r.mode,state,online:observed.online,lastSeenAt:r.updatedAt,
    reason:r.stoppedAt !== null?'loop-ended':state==='unknown'?'clock-invalid':observed.reason};
}

export function workerStatus(state, { now=Date.now(), probe=observeWorker } = {}) {
  const dir=join(state,'workers'), records=[];
  let complete=true, reason=null, directory;
  try {
    privateDirectory(dir);
    directory=opendirSync(dir,{bufferSize:1});
    let count=0, entry;
    while ((entry=directory.readSync())) {
      if (++count > MAX_WORKER_FILES) { complete=false;reason='file-count-limit';break; }
      if (!entry.name.endsWith('.json')) continue;
      const id=entry.name.slice(0,-5);
      try {
        if (!UUID.test(id)) throw Error('invalid-filename');
        const r=readRecord(join(dir,entry.name),id,now,probe);
        records.push(r);
        if (r.state === 'unknown') complete=false;
      } catch (e) {
        complete=false;
        const known=['record-too-large','unsafe-record','invalid-record','invalid-filename'];
        records.push({id:UUID.test(id)?id:null,mode:null,state:'unknown',online:null,lastSeenAt:null,
          reason:known.includes(e.message)?e.message:'record-unreadable'});
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { complete=false;reason='directory-unavailable'; }
    // An ENOENT after opening the directory is an observation failure too.
    else if (directory) { complete=false;reason='directory-unavailable'; }
  } finally {
    try { directory?.closeSync(); } catch { complete=false;reason='directory-unavailable'; }
  }
  const daemons=records.filter(r=>r.mode==='daemon');
  const stateValue=daemons.some(r=>r.state==='recent')?'recent':!complete?'unknown'
    :daemons.some(r=>r.state==='stale')?'stale':daemons.length?'stopped':'missing';
  const lastSeenAt=records.reduce((last,r)=>r.lastSeenAt === null?last:Math.max(last ?? 0,r.lastSeenAt),null);
  const descriptions={
    recent:'A recorded daemon updated recently; this does not prove notification acceptance, inbox retrieval or ack.',
    stale:'Recorded daemon updates are stale; a worker may be busy, paused or stopped.',
    stopped:'The recorded daemon loops ended or their process exit was observed.',
    missing:'No continuous worker record was found.',
    unknown:'Worker observation is incomplete or unavailable.'
  };
  const detail=`${descriptions[stateValue]}${complete?'':' Observation is incomplete.'} Older, unrecorded workers may still run. Check the selected state directory and the host service (seatwire.service) or manual daemon; manual inbox remains available. Reading or replying does not mark messages read; only ack records processing.`;
  return {state:stateValue,complete,lastSeenAt,reason,records,detail};
}
