import { runCodexQueue } from '../vendor/agmsg/codex-queue-io.mjs';
import { sendClaudeCodeMessage, latestPermissionMode } from '../vendor/agmsg/claude-code-queue-io.mjs';
import { dirname } from 'node:path';
import { socketWitness } from './identity.mjs';
export async function tick(store) {
  const row = store.claim();
  if (!row) return false;
  try {
    const target = JSON.parse(row.target);
    if (!store.targetAlive(row.team,row.name,target)) throw Error('session process expired');
    const command = `seatwire --team ${row.team} --name ${row.name} --state-home ${shellQuote(dirname(dirname(store.path)))}`;
    const body = `[seatwire:${row.generation}:${row.upto}] New messages. Run ${command} inbox. After processing, acknowledge only handled message IDs with ${command} ack ID... . Reading or replying does not mark messages read.`;
    let result;
    if (row.kind === 'codex') {
      result = await runCodexQueue({ executable: process.env.SEATWIRE_CODEX || 'codex', codexHome: target.home, thread: target.session, message: body, timeoutMs: 5000 });
      if (result.kind !== 'queued') throw Error(result.reason || result.kind);
    } else {
      if (socketWitness(target.socket) !== target.socketWitness) throw Error('socket replaced');
      result = await sendClaudeCodeMessage({socketPath:target.socket,token:target.token,nonce:row.lease,body,fromMode:latestPermissionMode(target.transcript || '')==='bypassPermissions'?'bypass':'',timeoutMs:5000});
      if (result.state !== 'sent') throw Error(result.reason);
    }
    store.finish(row,null);
  } catch(e) { store.finish(row,e.message); }
  return true;
}

function shellQuote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
