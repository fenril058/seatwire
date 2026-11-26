import { readFileSync, lstatSync, readlinkSync } from 'node:fs';

// Ownership decisions need positive evidence. Keep alive()'s legacy delivery and
// display semantics separate; an unreadable process must not release a name.
export function observeOwnership(record, {readFile=readFileSync,lstat=lstatSync,readlink=readlinkSync,signal=(pid)=>process.kill(pid,0)} = {}) {
  const unknown=reason=>({state:'unknown',reason});
  if (!record || !Number.isSafeInteger(record.pid) || record.pid<2
      || typeof record.witness!=='string'
      || !new RegExp(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:${record.pid}:\\d+$`).test(record.witness)) return unknown('invalid-process-record');
  try {
    // State and the real boot_id belong to one Linux host. A different boot
    // proves exit without interpreting a PID in the observer's namespace.
    const boot=readFile('/proc/sys/kernel/random/boot_id','utf8').trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) return unknown('boot-unavailable');
    if (record.witness.split(':')[0]!==boot) return {state:'absent',reason:'boot-changed'};
    const namespace=readlink('/proc/self/ns/pid');
    if (!record.pidNamespace || record.pidNamespace!==namespace) return unknown('pid-namespace-unavailable');
    const pids=readFile('/proc/self/status','utf8').match(/^NSpid:\s*(.+)$/m)?.[1].trim().split(/\s+/);
    if (readlink('/proc/self')!==String(process.pid) || pids?.length!==1 || pids[0]!==String(process.pid)) return unknown('proc-namespace-unavailable');
    try {
      if(lstat(`/proc/${record.pid}`).uid!==process.getuid()) return unknown('process-owner-unavailable');
      const fields=readFile(`/proc/${record.pid}/stat`,'utf8').split(') ').at(-1).split(' ');
      if (!/^\d+$/.test(fields[19]||'')) return unknown('invalid-process-stat');
      if (fields[0]==='Z'||fields[0]==='X') return {state:'absent',reason:'process-exited'};
      return `${boot}:${record.pid}:${fields[19]}`===record.witness
        ? {state:'present',reason:'process-verified'} : {state:'absent',reason:'witness-mismatch'};
    } catch(e) {
      if(e.code==='ENOENT') {
        // A sandbox can hide proc entries. Missing proc data alone is not exit
        // evidence; confirm absence in the already verified PID namespace.
        try {signal(record.pid);}
        catch(error) {if(error.code==='ESRCH') return {state:'absent',reason:'process-exited'};}
      }
      return unknown('process-unobservable');
    }
  } catch {return unknown('process-unobservable');}
}

export function requireObservedOwnership(record) {
  const observation=observeOwnership(record);
  if(observation.state==='unknown') throw Error(`cannot verify existing name ownership (${observation.reason}); registration and managed records retained`);
  return observation.state==='present';
}
