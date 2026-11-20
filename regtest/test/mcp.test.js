'use strict';
// End-to-end test of the MCP server through a real MCP client over stdio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(__dirname, '..');
const PORT = '4017';
const hasBrowser = !!process.env.REGTEST_CHROMIUM;

test('MCP server: full workflow', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mcp-'));
  const proj = path.join(tmp, 'demo');
  fs.cpSync(path.join(root, 'examples/demo'), proj, { recursive: true, filter: (s) => !/\.regtest|drafts|node_modules/.test(s) });
  const app = spawn('node', [path.join(proj, 'app/server.js')], { env: { ...process.env, PORT }, stdio: 'ignore' });
  const client = new Client({ name: 'test', version: '0' });
  t.after(async () => { app.kill(); await client.close().catch(() => {}); });
  await new Promise((r) => setTimeout(r, 600));
  await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, 'bin/regtest-mcp.js'), '--project', proj],
    env: { ...process.env, REGTEST_BASE_URL: `http://localhost:${PORT}` } }));

  const call = async (name, args) => client.callTool({ name, arguments: args || {} });
  const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

  const names = (await client.listTools()).tools.map((x) => x.name);
  for (const n of ['regtest_run_cases', 'regtest_select_cases', 'regtest_get_failure', 'regtest_save_draft', 'regtest_approve_draft',
    'regtest_update_case_file', 'regtest_triage_failures', 'regtest_authoring_guide', 'regtest_add_impact_rule']) assert.ok(names.includes(n), n);
  assert.strictEqual((await client.listPrompts()).prompts.length, 3);

  // selection by explicit changed files, with reasons
  const sel = json(await call('regtest_select_cases', { files: ['regtest/examples/demo/app/server.js'] }));
  assert.deepStrictEqual(sel.impactedTags, ['cart', 'order']);

  // run API-only cases (no browser needed), wait for completion
  const run = json(await call('regtest_run_cases', { ids: ['ORD-001', 'ORD-002', 'ORD-004'], retries: 0, waitSeconds: 60 }));
  assert.strictEqual(run.state, 'done');
  assert.deepStrictEqual([run.summary.passed, run.summary.failed], [2, 1]);
  assert.ok(fs.existsSync(run.report));
  const failed = json(await call('regtest_get_results', { status: 'failed' }));
  assert.deepStrictEqual(failed.results.map((r) => r.id), ['ORD-004']);
  const tri = json(await call('regtest_triage_failures'));
  assert.strictEqual(tri.needsAnalysis.length, 1);
  assert.strictEqual(json(await call('regtest_run_status')).state, 'done');
  assert.ok(json(await call('regtest_list_runs')).length >= 1);

  // authoring: invalid rejected, valid saved as draft, not part of suite until approved
  const bad = json(await call('regtest_validate_cases', { yaml: 'id: X\nsteps:\n  - teleport: /' }));
  assert.strictEqual(bad.valid, false);
  assert.strictEqual((await call('regtest_save_draft', { name: 'x', yaml: 'id: X\nsteps:\n  - teleport: /' })).isError, true);
  const yaml = 'id: NEW-1\ntitle: api health\ntags: [smoke]\nsteps:\n  - api: { url: /api/health, expectJson: { ok: true } }\n';
  assert.strictEqual(json(await call('regtest_save_draft', { name: 'new feature', yaml })).cases[0], 'NEW-1');
  assert.strictEqual(json(await call('regtest_list_cases', { query: 'NEW-1' })).count, 0);
  assert.deepStrictEqual(json(await call('regtest_approve_draft', { name: 'new_feature.yaml' })).approved, ['NEW-1']);
  assert.strictEqual(json(await call('regtest_list_cases', { query: 'NEW-1' })).count, 1);
  const r2 = json(await call('regtest_run_cases', { ids: ['NEW-1'], waitSeconds: 30 }));
  assert.strictEqual(r2.summary.passed, 1);

  // update existing case file; path traversal and invalid yaml refused
  const upd = await call('regtest_update_case_file', { file: 'cases/new_feature.yaml', yaml: yaml.replace('api health', 'api health v2') });
  assert.ok(!upd.isError);
  assert.strictEqual((await call('regtest_update_case_file', { file: '../../etc/passwd', yaml })).isError, true);
  assert.strictEqual((await call('regtest_update_case_file', { file: 'cases/new_feature.yaml', yaml: 'id: CART-001\nsteps:\n  - goto: /' })).isError, true);   // id clash

  // impact rule keeps comments in config
  await call('regtest_add_impact_rule', { paths: ['new/**'], tags: ['order'] });
  const cfg = fs.readFileSync(path.join(proj, 'regtest.config.yaml'), 'utf8');
  assert.ok(cfg.includes('known to be irrelevant') && cfg.includes('new/**'));

  // failure detail with screenshot (needs a browser)
  if (hasBrowser) {
    fs.writeFileSync(path.join(proj, 'cases/web-fail.yaml'), 'id: WEB-FAIL\nsteps:\n  - goto: /\n  - click: "#nope"\n');
    await call('regtest_run_cases', { ids: ['WEB-FAIL'], retries: 0, waitSeconds: 60 });
    const f = await call('regtest_get_failure', { caseId: 'WEB-FAIL' });
    assert.ok(f.content.some((c) => c.type === 'image'));
  }
});
