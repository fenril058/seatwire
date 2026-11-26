import { readFileSync, lstatSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../../src/store.mjs';
import { witness, pidNamespace, alive } from '../../src/identity.mjs';
import { launch, despawn } from '../../src/spawn.mjs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
const store=new Store(data.base+'/seatwire');
let calls=0;
cp.spawnSync=()=>{calls++;return {status:1,stderr:'fixture: no real tmux',stdout:''};};
syncBuiltinESMExports();
let denied=null;try{lstatSync('/proc/'+data.old.pid);}catch(e){denied=e.code;}
let error=null,result=null;
try {
  const incoming={...data.old,pid:process.pid,witness:witness(process.pid),pidNamespace:pidNamespace(),session:data.next};
  switch(data.action) {
    case 'replace':store.register('test','owner','codex',incoming);break;
    case 'offline':store.register('test','owner','codex');break;
    case 'identical':store.register('test','owner','codex',data.old);break;
    case 'resume':store.registerSession('codex',{...incoming,session:data.old.session},{source:'resume',project:{team:'test'}});break;
    case 'expected': {
      const record=store.db.prepare('SELECT record FROM launches WHERE team=? AND name=?').get('test','owner').record;
      const payload=store.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(data.launchId).payload;
      store.register('test','owner','codex',{...incoming,launchId:data.launchId},{record,payload});break;
    }
    case 'launch':result=launch(store,'test','owner','codex',{cli:new URL('../../src/cli.mjs',import.meta.url).pathname});break;
    case 'despawn':case 'despawn-starting':case 'despawn-legacy':case 'despawn-legacy-verified':case 'despawn-failed':case 'despawn-socket':result=despawn(store,'test','owner',false);break;
    case 'despawn-legacy-force':result=despawn(store,'test','owner',true);break;
    default:throw Error('unexpected fixture action');
  }
} catch(e) {error=e.message;}
console.log(JSON.stringify({denied,namespaceSame:pidNamespace()===data.old.pidNamespace,oldAlive:alive(data.old),error,result,tmuxCalls:calls}));
store.close();
