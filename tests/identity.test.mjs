import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Codex launched with bare argv[0] resolves its actual ancestor PID', () => {
  const child = `import { ancestor } from ${JSON.stringify(new URL('../src/identity.mjs', import.meta.url).href)}; process.stdout.write(String(ancestor('codex')));`;
  const parent = `import { spawnSync } from 'node:child_process'; const r = spawnSync(process.execPath, ['--input-type=module','-e',${JSON.stringify(child)}], {encoding:'utf8'}); console.log(JSON.stringify({expected:process.pid,actual:Number(r.stdout),status:r.status,error:r.stderr}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', parent], {argv0:'codex',encoding:'utf8'});
  assert.equal(result.status, 0);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.status, 0, observed.error);
  assert.equal(observed.actual, observed.expected);
});
