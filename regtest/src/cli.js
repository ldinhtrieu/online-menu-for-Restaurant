'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { loadCases } = require('./cases');
const { select, gitChangedFiles } = require('./select');
const { runAll } = require('./runner');
const { writeReports } = require('./report');

const HELP = `regtest - shared regression runner

Usage: regtest <command> [options]
  init [dir]        scaffold regtest.config.yaml + sample case
  list              list all cases
  select            show which cases would run (and why), without running
  run               run selected cases, write report to <outDir>/runs/<ts>/report.html

Selection (combine freely; results are a union):
  --all                    every case
  --changed [base]         impact analysis from git diff (vs base ref, plus working tree)
  --files a,b              same as --changed but with an explicit file list
  --tags t1,t2             cases having any of these tags
  --priority P0,P1         cases with these priorities
  --ids TC-1,TC-2          explicit ids
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
    if (['all', 'headed', 'json', 'help'].includes(k)) o[k] = true;
    else if (k === 'changed') { if (nxt && !nxt.startsWith('--')) { o.changed = nxt; i++; } else o.changed = true; }
    else { o[k] = nxt; i++; }
  }
  return o;
}
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function buildSelection(cfg, cases, o) {
  const opts = { all: !!o.all, ids: csv(o.ids), tags: csv(o.tags), priorities: csv(o.priority) };
  if (o.files) opts.changed = csv(o.files);
  else if (o.changed) {
    const { files, top } = gitChangedFiles(cfg.root, o.changed === true ? null : o.changed);
    // map repo-relative paths to be relative to the git top (impact globs are repo-relative)
    opts.changed = files; opts.gitTop = top;
  }
  if (!opts.all && !opts.ids && !opts.tags && !opts.priorities && !opts.changed) opts.all = true;
  const sel = select(cases, cfg, opts);
  sel.mode = Object.entries({ all: opts.all, ids: opts.ids, tags: opts.tags, priority: opts.priorities, changed: opts.changed && `${opts.changed.length} file(s)` })
    .filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => (v === true ? k : `${k}=${[].concat(v).join(',')}`)).join(' ');
  sel.changedFiles = opts.changed;
  return sel;
}

async function main(argv) {
  const o = parse(argv); const cmd = o._[0];
  if (!cmd || o.help || cmd === 'help') { console.log(HELP); return 0; }
  if (cmd === 'init') return init(o._[1] || o.project || '.');

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
  if (cmd !== 'select' && cmd !== 'run') { console.error(`Unknown command ${cmd}\n\n${HELP}`); return 2; }

  const sel = buildSelection(cfg, cases, o);
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
  const outRoot = path.resolve(cfg.root, cfg.outDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(outRoot, 'runs', ts); fs.mkdirSync(runDir, { recursive: true });
  const lastFile = path.join(outRoot, 'last.json');
  const previous = fs.existsSync(lastFile) ? JSON.parse(fs.readFileSync(lastFile, 'utf8')) : null;
  console.log(`Running ${sel.selected.length}/${cases.length} cases (${sel.mode}) against ${cfg.baseUrl}`);
  sel.notes.forEach((n) => console.log('NOTE: ' + n));
  const startedAt = new Date().toISOString();
  const results = await runAll(sel.selected, cfg, runDir, (r) =>
    console.log(`  ${r.status === 'passed' ? (r.flaky ? 'FLAKY' : 'PASS ') : 'FAIL '} ${r.id.padEnd(12)} ${r.title} (${r.ms}ms${r.attempts > 1 ? `, ${r.attempts} attempts` : ''})${r.error ? '\n        ' + r.error.split('\n')[0] : ''}`));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const meta = { project: cfg.name, startedAt, baseUrl: cfg.baseUrl, mode: sel.mode };
  const data = writeReports(cfg, runDir, meta, results, previous);
  fs.writeFileSync(lastFile, JSON.stringify({ meta, results: results.map(({ id, status }) => ({ id, status })) }));
  const s = data.summary; const reg = results.filter((r) => r.regression).map((r) => r.id);
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky of ${s.total} in ${(s.ms / 1000).toFixed(1)}s`);
  if (reg.length) console.log(`Regressions (passed last run, fail now): ${reg.join(', ')}`);
  console.log(`Report: ${path.join(runDir, 'report.html')}`);
  return s.failed ? 1 : 0;
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
