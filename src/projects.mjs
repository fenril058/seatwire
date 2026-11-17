import { openSync, closeSync, fstatSync, readSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { name } from './identity.mjs';

function absolute(path) {
  if (typeof path!=='string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw Error('invalid project path');
  return realpathSync(path);
}
// User-owned data only: never load a repository's executable configuration.
export function projectTeam(cwd, env = process.env) {
  const base=env.XDG_CONFIG_HOME || join(homedir(),'.config');
  if (!isAbsolute(base)) throw Error('XDG_CONFIG_HOME must be absolute');
  let fd;
  try { fd=openSync(join(base,'seatwire/projects.json'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch(e) { if(e.code==='ENOENT') return; throw Error('cannot read user project-team settings', {cause:e}); }
  let config;
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid() || (stat.mode&0o022)) throw Error('unsafe project-team settings ownership/type/permissions');
    const bytes=Buffer.alloc(65537);let length=0,n;
    while(length<bytes.length && (n=readSync(fd,bytes,length,bytes.length-length,null))) length+=n;
    if(length>65536) throw Error('project-team settings exceed 64 KiB');
    config=JSON.parse(bytes.subarray(0,length).toString('utf8'));
  } finally { closeSync(fd); }
  if (!config || config.version!==1 || !config.projects || typeof config.projects!=='object' || Array.isArray(config.projects)
      || Object.keys(config).some(k=>!['version','projects'].includes(k))) throw Error('invalid project-team settings; expected version 1 and projects object');
  const projects=new Map();
  for(const [path,team] of Object.entries(config.projects)) {
    const root=absolute(path);
    if(typeof team!=='string') throw Error('project team must be a string');
    name(team);
    if(projects.has(root)) throw Error('duplicate canonical project root');
    projects.set(root,team);
  }
  if(!projects.size) return;
  const directory=absolute(cwd);
  // Inherited GIT_DIR/GIT_WORK_TREE must not select a different worktree.
  const gitEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('GIT_')));
  const result=spawnSync('git',['-c','core.fsmonitor=false','-C',directory,'rev-parse','--show-toplevel'],{
    env:{...gitEnv,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',LC_ALL:'C'},encoding:'utf8',timeout:2000,maxBuffer:65536,
  });
  if(result.error) throw Error('cannot observe Git worktree root',{cause:result.error});
  if(result.status!==0) {
    if(result.status===128 && /^fatal: not a git repository \(/.test(result.stderr)) return;
    throw Error('cannot observe Git worktree root');
  }
  return projects.get(absolute(result.stdout.replace(/\r?\n$/,'')));
}
