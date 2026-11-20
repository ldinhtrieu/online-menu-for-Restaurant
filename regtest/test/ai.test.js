'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AI, stripFence } = require('../src/ai');
const { triage } = require('../src/ai-tasks');
const { fromDoc } = require('../src/cases');
const { DEFAULTS } = require('../src/config');

test('stripFence', () => {
  assert.strictEqual(stripFence('```yaml\na: 1\n```'), 'a: 1');
  assert.strictEqual(stripFence('a: 1'), 'a: 1');
});

test('triage settles environment errors without AI, leaves the rest', () => {
  assert.strictEqual(triage('fetch failed').kind, 'environment');
  assert.strictEqual(triage('GET /x -> 500, expected 200').kind, 'backend-error');
  assert.strictEqual(triage('Text of #a is "1", expected "2"'), null);
});

test('fromDoc validates AI output', () => {
  const ok = fromDoc({ tags: ['t'], cases: [{ id: 'A', steps: [{ goto: '/' }] }] }, 'x');
  assert.strictEqual(ok.cases.length, 1);
  assert.deepStrictEqual(ok.cases[0].tags, ['t']);
  const bad = fromDoc({ cases: [{ id: 'B', steps: [{ teleport: '/' }] }] }, 'x');
  assert.strictEqual(bad.errors.length, 1);
});

test('AI wrapper: parses claude JSON, tracks usage, caches, honours call limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({result:'echo:'+s.trim(),total_cost_usd:0.01,usage:{input_tokens:10,output_tokens:5}})));`);
  fs.chmodSync(fake, 0o755);
  const cfg = { root: dir, outDir: '.o', ai: { ...DEFAULTS.ai, command: fake, maxCalls: 2 } };
  const ai = new AI(cfg);
  assert.strictEqual(await ai.ask('explain', 'hi', { useCache: true }), 'echo:hi');
  assert.strictEqual(await ai.ask('explain', 'hi', { useCache: true }), 'echo:hi');   // cached
  assert.strictEqual(ai.usage.calls, 1);
  assert.strictEqual(ai.usage.cached, 1);
  assert.strictEqual(ai.usage.inputTokens, 10);
  await ai.ask('gen', 'b');
  await assert.rejects(() => ai.ask('gen', 'c'), /call limit/);
});
