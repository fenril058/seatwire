import { readFileSync, lstatSync } from 'node:fs';
export function name(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value ?? '')) throw Error('invalid team/agent name');
  return value;
}
export function witness(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('invalid pid');
  const st = lstatSync(`/proc/${pid}`);
  if (st.uid !== process.getuid()) throw Error('process owner mismatch');
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
  if (fields[0] === 'Z') throw Error('process is zombie');
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${pid}:${fields[19]}`;
}
export function alive(r) { try { return witness(r.pid) === r.witness; } catch { return false; } }
export function ancestor(kind) {
  let pid = process.ppid;
  for (let i = 0; i < 20 && pid > 1; i++) {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
    if ((kind === 'codex' && /(^|\/)codex$/.test(cmd)) || (kind === 'claude-code' && /(^|\/)claude$/.test(cmd))) return pid;
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    pid = Number(fields[1]);
  }
  throw Error('cannot identify agent ancestor; register from the agent lifecycle hook');
}
export function socketWitness(path) {
  const s = lstatSync(path);
  if (!s.isSocket() || s.uid !== process.getuid()) throw Error('socket ownership/type mismatch');
  return `${s.dev}:${s.ino}`;
}
