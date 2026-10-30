import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';

test('managed SessionStart submits the exact UUID without a Codex ancestor',t=>{
 const dir=mkdtempSync(join(tmpdir(),'sw-registration-'));const s=new Store(join(dir,'seatwire'));
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const id=randomUUID(),session=randomUUID();
 s.register('test','codex','codex');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','codex',JSON.stringify({id,kind:'codex',phase:'launching'}));
 const r=spawnSync(process.execPath,[resolve('src/cli.mjs'),'--team','test','--name','codex','hook','--kind','codex','--launch-id',id],{input:JSON.stringify({session_id:session,cwd:process.cwd()}),encoding:'utf8',env:{...process.env,XDG_STATE_HOME:dir}});
 assert.equal(r.status,0,r.stderr);
 const request=s.db.prepare('SELECT payload FROM pending_registrations WHERE launch_id=?').get(id);
 assert.equal(JSON.parse(request.payload).session,session);
 assert.equal(s.status()[0].online,false);
});

test('schema 1 migration preserves messages and launches', t => {
 const dir=mkdtempSync(join(tmpdir(),'sw-migration-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let s=new Store(join(dir,'seatwire'));
 s.register('test','a','codex');s.register('test','b','claude-code');
 const id=s.send('test','a','b','persist across migration');
 s.db.prepare('INSERT INTO launches VALUES(?,?,?)').run('test','a',JSON.stringify({socket:'/old/socket',pid:123,witness:'old'}));
 s.db.exec('DROP TABLE pending_registrations; PRAGMA user_version=1');s.close();
 s=new Store(join(dir,'seatwire'));t.after(()=>s.close());
 assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,2);
 assert.equal(s.inbox('test','b')[0].id,id);
 assert.equal(s.inbox('test','b')[0].body,'persist across migration');
 assert.equal(JSON.parse(s.db.prepare('SELECT record FROM launches').get().record).socket,'/old/socket');
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM pending_registrations').get().n,0);
});
