#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from './store.mjs';
import { ancestor, witness, socketWitness } from './identity.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, despawn, launchStatus } from './spawn.mjs';
import { submitRegistration, reconcileRegistrations, waitReady } from './registration.mjs';
import { tick } from './notify.mjs';
import { sessionId, automaticName, currentIdentity, projectPath } from './context.mjs';
function absolute(v) { if (!isAbsolute(v || '') || /[\x00-\x1f]/.test(v)) throw Error('invalid absolute path'); return v; }
export function registration(kind, input={}, env=process.env) {
  if (!['codex','claude-code'].includes(kind)) throw Error('unknown agent kind');
  const session = sessionId(kind, input, env);
  const pid = ancestor(kind);
  const target = { session,pid,witness:witness(pid),project:projectPath(absolute(input.cwd || process.cwd())) };
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
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{team:{type:'string'},name:{type:'string'},to:{type:'string'},kind:{type:'string'},help:{type:'boolean'},all:{type:'boolean'},once:{type:'boolean'},force:{type:'boolean'},'boot-prompt':{type:'string'},resume:{type:'string'},'launch-id':{type:'string'},'state-home':{type:'string'},'wait-ready':{type:'boolean'},'ready-timeout':{type:'string'}}});
  let team=v.team || process.env.SEATWIRE_TEAM;
  let who=v.name || process.env.SEATWIRE_NAME;
  const command=p.shift();
  if (!command || v.help) { console.log(`seatwire [--team TEAM] [--name AGENT] COMMAND
register --kind codex|claude-code  Register an offline mailbox
actas --kind KIND                Bind this agent session from its environment
hook --kind KIND                 Bind from SessionStart JSON on stdin
peers [--all]                   Find live peers in this project (all includes offline/other projects)
whoami                          Show this session identity
reply ID MESSAGE                Reply to a received message without marking it read
send --to AGENT MESSAGE          Persist a message
inbox                           Show unread messages without marking read
ack ID...                       Mark explicit received IDs read
history                         Show sent and received messages
status                          List registrations and notification errors
doctor                          Report runtime and integration capabilities
daemon [--once]                 Run host notifications
spawn KIND NAME [--boot-prompt TEXT] [--resume UUID] [--wait-ready] [--ready-timeout MS]
despawn NAME [--force]           Interrupt or explicitly kill a managed session
Use --state-home PATH to select an explicit XDG state base.
SessionStart automatically assigns an identity; explicit team/name override it.`); return; }
  const store=new Store(v['state-home'] ? join(absolute(v['state-home']),'seatwire') : undefined);
  try {
    let result;
    if (['send','inbox','history','ack','reply','whoami'].includes(command)) {
      const identity = currentIdentity(store, {team, who});
      team = identity.team; who = identity.name;
    }
    if (!team && ['peers','spawn','despawn'].includes(command)) team = currentIdentity(store, {who, required:false})?.team;
    team ||= 'default';
    switch(command) {
      case 'spawn': {
        const timeout=Number(v['ready-timeout'] || 30000);
        if (!Number.isSafeInteger(timeout) || timeout<1 || timeout>300000) throw Error('invalid ready timeout');
        result=launch(store,team,p[1],p[0],{prompt:v['boot-prompt'],resume:v.resume,cli:fileURLToPath(import.meta.url)});
        if (v['wait-ready']) { await waitReady(store,team,p[1],result.launchId,timeout); result.registration='ready'; }
        break;
      }
      case 'despawn': result=despawn(store,team,p[0],v.force); break;
      case 'register': store.register(team,who,v.kind); result={registered:who}; break;
      case 'actas': case 'hook': {
        const input=command==='hook'?JSON.parse(readFileSync(0,'utf8')):{};
        who ||= automaticName(v.kind, sessionId(v.kind, input));
        const launchId=v['launch-id'] || process.env.SEATWIRE_LAUNCH_ID;
        if (command==='hook' && launchId) submitRegistration(store,team,who,v.kind,launchId,input);
        else {
          if (v['launch-id']) throw Error('launch-id is only accepted by SessionStart hook');
          store.register(team,who,v.kind,registration(v.kind,input));
        }
        if (command==='hook') { console.log(`seatwire: ${who}@${team}; use seatwire peers, seatwire inbox, and seatwire send --to NAME MESSAGE. Use peers --all to include offline mailboxes. Only collaborate when authorized by the user.`); return; }
        result={registered:who}; break;
      }
      case 'whoami': result={team,name:who}; break;
      case 'peers': result=store.peers(team,process.cwd(),v.all); break;
      case 'reply': result={id:store.reply(team,who,Number(p.shift()),p.join(' '))}; break;
      case 'send': result={id:store.send(team,who,v.to,p.join(' '))}; break;
      case 'inbox': case 'history': result=store.inbox(team,who,command==='history'); break;
      case 'ack': result={marked:store.ack(team,who,p.map(Number))}; break;
      case 'status': result={agents:store.status(),launches:launchStatus(store)}; break;
      case 'doctor': result={node:process.version,state:dirname(store.path),schema:2,agents:store.status(),codexQueue:spawnSync(process.env.SEATWIRE_CODEX || 'codex',['queue','--help'],{timeout:5000,encoding:'utf8'}).status===0,claudeVersion:spawnSync('claude',['--version'],{timeout:5000,encoding:'utf8'}).stdout?.trim() || 'unavailable',notice:'Transport success does not prove agent consumption; see docs/VALIDATION.md.'}; break;
      case 'daemon': {
        let stop=false;
        process.on('SIGTERM',()=>{stop=true;}); process.on('SIGINT',()=>{stop=true;});
        do { reconcileRegistrations(store); const work=await tick(store); if(v.once) break; if(!work) await new Promise(r=>setTimeout(r,1000)); } while(!stop);
        return;
      }
      default: throw Error(`unknown command: ${command}`);
    }
    console.log(JSON.stringify(result,null,2));
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(`seatwire: ${e.message}`);process.exitCode=1;});
