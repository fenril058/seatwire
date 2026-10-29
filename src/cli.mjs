#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store, statePath } from './store.mjs';
import { ancestor, witness, socketWitness } from './identity.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, despawn, launchStatus } from './spawn.mjs';
import { tick } from './notify.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function absolute(v) { if (!isAbsolute(v || '') || /[\x00-\x1f]/.test(v)) throw Error('invalid absolute path'); return v; }
export function registration(kind, input={}, env=process.env) {
  if (!['codex','claude-code'].includes(kind)) throw Error('unknown agent kind');
  const session = input.session_id || (kind==='codex' ? env.CODEX_THREAD_ID : env.CLAUDE_SESSION_ID);
  if (!uuid.test(session || '')) throw Error('missing authoritative session UUID');
  if (kind==='codex' && env.CODEX_THREAD_ID && env.CODEX_THREAD_ID!==session) throw Error('conflicting session IDs');
  const pid = ancestor(kind);
  const target = { session,pid,witness:witness(pid),project:absolute(input.cwd || process.cwd()) };
  if (kind==='codex') target.home=absolute(env.CODEX_HOME || join(homedir(),'.codex'));
  else {
    target.socket=absolute((env.CLAUDE_CODE_MESSAGING_SOCKET || '').replace(/^uds:/,''));
    target.socketWitness=socketWitness(target.socket);
    target.token=env.CLAUDE_CODE_MESSAGING_TOKEN || '';
    if (target.token && !/^[A-Za-z0-9._-]+$/.test(target.token)) throw Error('invalid messaging token');
    target.transcript=input.transcript_path ? absolute(input.transcript_path) : '';
  }
  return target;
}
async function main() {
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{team:{type:'string'},name:{type:'string'},to:{type:'string'},kind:{type:'string'},help:{type:'boolean'},once:{type:'boolean'},force:{type:'boolean'},'boot-prompt':{type:'string'},resume:{type:'string'}}});
  const team=v.team || process.env.SEATWIRE_TEAM || 'default';
  const who=v.name || process.env.SEATWIRE_NAME;
  const command=p.shift();
  if (!command || v.help) { console.log(`seatwire [--team TEAM] [--name AGENT] COMMAND
register --kind codex|claude-code  Register an offline mailbox
actas --kind KIND                Bind this agent session from its environment
hook --kind KIND                 Bind from SessionStart JSON on stdin
send --to AGENT MESSAGE          Persist a message
inbox                           Show unread messages without marking read
ack ID...                       Mark explicit received IDs read
history                         Show sent and received messages
status                          List registrations and notification errors
doctor                          Report runtime and integration capabilities
daemon [--once]                 Run host notifications
spawn KIND NAME [--boot-prompt TEXT] [--resume UUID]
despawn NAME [--force]           Interrupt or explicitly kill a managed session
Use SEATWIRE_TEAM and SEATWIRE_NAME for hook/session identity.`); return; }
  const store=new Store();
  try {
    let result;
    switch(command) {
      case 'spawn': result=launch(store,team,p[1],p[0],{prompt:v['boot-prompt'],resume:v.resume,cli:fileURLToPath(import.meta.url)}); break;
      case 'despawn': result=despawn(store,team,p[0],v.force); break;
      case 'register': store.register(team,who,v.kind); result={registered:who}; break;
      case 'actas': case 'hook': {
        if (!who && command==='hook') return;
        const input=command==='hook'?JSON.parse(readFileSync(0,'utf8')):{};
        store.register(team,who,v.kind,registration(v.kind,input));
        if (command==='hook') { console.log(`seatwire: ${who}@${team}; run seatwire --team ${team} --name ${who} inbox.`); return; }
        result={registered:who}; break;
      }
      case 'send': result={id:store.send(team,who,v.to,p.join(' '))}; break;
      case 'inbox': case 'history': result=store.inbox(team,who,command==='history'); break;
      case 'ack': result={marked:store.ack(team,who,p.map(Number))}; break;
      case 'status': result={agents:store.status(),launches:launchStatus(store)}; break;
      case 'doctor': result={node:process.version,state:statePath(),schema:1,agents:store.status(),codexQueue:spawnSync(process.env.SEATWIRE_CODEX || 'codex',['queue','--help'],{timeout:5000,encoding:'utf8'}).status===0,claudeVersion:spawnSync('claude',['--version'],{timeout:5000,encoding:'utf8'}).stdout?.trim() || 'unavailable',notice:'Transport success does not prove agent consumption; see docs/VALIDATION.md.'}; break;
      case 'daemon': {
        let stop=false;
        process.on('SIGTERM',()=>{stop=true;}); process.on('SIGINT',()=>{stop=true;});
        do { const work=await tick(store); if(v.once) break; if(!work) await new Promise(r=>setTimeout(r,1000)); } while(!stop);
        return;
      }
      default: throw Error(`unknown command: ${command}`);
    }
    console.log(JSON.stringify(result,null,2));
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(`seatwire: ${e.message}`);process.exitCode=1;});
