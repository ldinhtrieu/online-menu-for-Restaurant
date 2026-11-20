'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { loadCases } = require('./cases');
const { buildSelection: build, startRun } = require('./engine');
const { gen, approve, explain } = require('./ai-tasks');
const { execFileSync } = require('child_process');

const HELP = `regtest - shared regression runner

Usage: regtest <command> [options]
  init [dir]        scaffold regtest.config.yaml + sample case
  list              list all cases
  select            show which cases would run (and why), without running
  mcp               start the MCP server (stdio) for GitHub Copilot / other MCP clients
  run               run selected cases, write report to <outDir>/runs/<ts>/report.html
  gen               AI (Claude CLI) drafts cases from a ticket/diff into <draftsDir>/ for review
  approve <draft>   validate a draft and move it into cases/
  explain           triage failures of the last run (rules first, AI only for what is left)

Selection (combine freely; results are a union):
  --all                    every case
  --changed [base]         impact analysis from git diff (vs base ref, plus working tree)
  --files a,b              same as --changed but with an explicit file list
  --tags t1,t2             cases having any of these tags
  --priority P0,P1         cases with these priorities
  --ids TC-1,TC-2          explicit ids
AI (uses the "claude" CLI you are logged into - no API key):
  gen --from <file> | --text "<desc>" | --diff [base]   [--name <draft-name>]
  run --explain            after a run, triage failures
Other:
  --project <dir>          project dir containing regtest.config.yaml (default: cwd)
  --workers N  --retries N  --screenshots all|failure|none  --headed
  --json                   machine-readable output for select/list
Exit code: 0 all passed, 1 failures, 2 usage/config error.`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2); const nxt = argv[i + 1];
    if (['all', 'headed', 'json', 'help', 'explain'].includes(k)) o[k] = true;
    else if (k === 'changed' || k === 'diff') { if (nxt && !nxt.startsWith('--')) { o[k] = nxt; i++; } else o[k] = true; }
    else { o[k] = nxt; i++; }
  }
  return o;
}
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv) {
  const o = parse(argv); const cmd = o._[0];
  if (!cmd || o.help || cmd === 'help') { console.log(HELP); return 0; }
  if (cmd === 'init') return init(o._[1] || o.project || '.');
  if (cmd === 'mcp') { await require('./mcp').main(argv.slice(1)); return new Promise(() => {}); }

  const cfg = loadConfig(o.project);
  if (o.workers) cfg.workers = Number(o.workers);
  if (o.retries !== undefined) cfg.retries = Number(o.retries);
  if (o.screenshots) cfg.screenshots = o.screenshots;
  if (o.headed) cfg.headless = false;
  const { cases, errors } = loadCases(cfg);
  if (errors.length) { console.error('Case errors:\n  ' + errors.join('\n  ')); return 2; }

  if (cmd === 'list') {
    if (o.json) console.log(JSON.stringify(cases, null, 2));
    else for (const c of cases) console.log(`${c.id.padEnd(12)} ${c.priority}  [${c.tags.join(',')}]  ${c.title}${c.skip ? '  (skipped)' : ''}`);
    return 0;
  }
  if (cmd === 'gen') return doGen(cfg, o);
  if (cmd === 'approve') {
    if (!o._[1]) { console.error('Usage: regtest approve <draft-file>'); return 2; }
    const r = approve(cfg, o._[1]); console.log(`Approved ${r.count} case(s) -> ${path.relative(cfg.root, r.dest)}`); return 0;
  }
  if (cmd === 'explain') {
    const last = path.resolve(cfg.root, cfg.outDir, 'last.json');
    if (!fs.existsSync(last)) { console.error('No previous run. Run "regtest run" first.'); return 2; }
    return doExplain(cfg, JSON.parse(fs.readFileSync(last, 'utf8')).runDir);
  }
  if (cmd !== 'select' && cmd !== 'run') { console.error(`Unknown command ${cmd}\n\n${HELP}`); return 2; }

  const sel = build(cfg, cases, { all: !!o.all, ids: csv(o.ids), tags: csv(o.tags), priorities: csv(o.priority),
    files: csv(o.files), changed: o.changed });
  if (cmd === 'select') {
    if (o.json) { console.log(JSON.stringify({ ...sel, selected: sel.selected.map((s) => ({ id: s.case.id, reasons: s.reasons })) }, null, 2)); return 0; }
    console.log(`Mode: ${sel.mode}`);
    if (sel.changedFiles) console.log(`Changed files: ${sel.changedFiles.length}  Impacted tags: ${sel.impactedTags.join(', ') || '(none)'}`);
    sel.unmapped.length && console.log(`Unmapped files: ${sel.unmapped.join(', ')}`);
    sel.notes.forEach((n) => console.log('NOTE: ' + n));
    console.log(`\n${sel.selected.length}/${cases.length} cases selected:`);
    for (const { case: c, reasons } of sel.selected) console.log(`  ${c.id.padEnd(12)} ${c.priority}  ${c.title}\n      ↳ ${reasons.join(', ')}`);
    return 0;
  }

  // run
  if (!sel.selected.length) { console.log('No cases selected - nothing to run.'); sel.notes.forEach((n) => console.log('NOTE: ' + n)); return 0; }
  console.log(`Running ${sel.selected.length}/${cases.length} cases (${sel.mode}) against ${cfg.baseUrl}`);
  sel.notes.forEach((n) => console.log('NOTE: ' + n));
  const run = startRun(cfg, sel, { onResult: (r) =>
    console.log(`  ${r.status === 'passed' ? (r.flaky ? 'FLAKY' : 'PASS ') : 'FAIL '} ${r.id.padEnd(12)} ${r.title} (${r.ms}ms${r.attempts > 1 ? `, ${r.attempts} attempts` : ''})${r.error ? '\n        ' + r.error.split('\n')[0] : ''}`) });
  const data = await run.done; const runDir = run.runDir; const results = data.results;
  const s = data.summary; const reg = results.filter((r) => r.regression).map((r) => r.id);
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky of ${s.total} in ${(s.ms / 1000).toFixed(1)}s`);
  if (reg.length) console.log(`Regressions (passed last run, fail now): ${reg.join(', ')}`);
  console.log(`Report: ${path.join(runDir, 'report.html')}`);
  if (o.explain && s.failed) await doExplain(cfg, runDir);
  return s.failed ? 1 : 0;
}

async function doGen(cfg, o) {
  let text;
  if (o.from) text = fs.readFileSync(path.resolve(o.from), 'utf8');
  else if (o.text) text = o.text;
  else if (o.diff) {
    const base = o.diff === true ? 'HEAD' : o.diff;
    text = execFileSync('git', ['diff', base], { cwd: cfg.root, encoding: 'utf8', maxBuffer: 20e6 });
    if (text.length > 60000) text = text.slice(0, 60000) + '\n...(diff truncated)';
  } else { console.error('Usage: regtest gen --from <file> | --text "<description>" | --diff [base]'); return 2; }
  if (!text.trim()) { console.error('Input is empty.'); return 2; }
  console.log('Asking Claude to draft cases...');
  try {
    const r = await gen(cfg, { text, name: o.name || (o.from ? path.basename(o.from, path.extname(o.from)) : 'generated') });
    console.log(`Drafted ${r.count} case(s) -> ${path.relative(cfg.root, r.file)}\nReview/edit it, then: regtest approve ${path.relative(cfg.root, r.file)}`);
    console.log(r.ai.summary());
    return 0;
  } catch (e) { console.error(e.message); if (e.ai) console.error(e.ai.summary()); return 1; }
}

async function doExplain(cfg, runDir) {
  try {
    const r = await explain(cfg, runDir);
    if (!r.total) { console.log('No failures to explain.'); return 0; }
    console.log(`\nFailure triage (${r.total}):`);
    for (const x of r.results) console.log(`  ${x.id.padEnd(12)} [${x.kind}] (${x.source})  ${x.note}`);
    console.log(r.ai.summary());
    return 0;
  } catch (e) { console.error('explain failed: ' + e.message); return 1; }
}

function init(dir) {
  const root = path.resolve(dir); fs.mkdirSync(path.join(root, 'cases'), { recursive: true });
  const w = (f, t) => { const p = path.join(root, f); if (fs.existsSync(p)) return console.log('exists  ' + f); fs.writeFileSync(p, t); console.log('created ' + f); };
  w('regtest.config.yaml', `name: my-project
baseUrl: http://localhost:3000
# apiBaseUrl: http://localhost:8080
retries: 1
workers: 2
screenshots: failure          # all | failure | none
alwaysRun: { tags: [smoke] }  # always included by --changed
onUnmapped: all               # changed file with no rule -> run everything (safe default)
impact:                       # source paths (relative to git root) -> tags
  - paths: ["src/cart/**"]
    tags: [cart]
`);
  w('cases/sample.yaml', `id: TC-001
title: Home page loads
priority: P0
tags: [smoke]
steps:
  - goto: /
  - expectVisible: body
`);
  return 0;
}
module.exports = { main };
