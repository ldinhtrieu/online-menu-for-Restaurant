'use strict';
// Shared by the CLI and the MCP server: selection, running, and reading past runs.
const fs = require('fs');
const path = require('path');
const { select, gitChangedFiles } = require('./select');
const { runAll } = require('./runner');
const { writeReports } = require('./report');

/** spec: { all, ids[], tags[], priorities[], files[], changed: true|<baseRef> } */
function buildSelection(cfg, cases, spec = {}) {
  const opts = { all: !!spec.all, ids: spec.ids, tags: spec.tags, priorities: spec.priorities };
  if (spec.files && spec.files.length) opts.changed = spec.files;
  else if (spec.changed) opts.changed = gitChangedFiles(cfg.root, spec.changed === true ? null : spec.changed).files;
  const nonEmpty = (a) => a && a.length;
  if (!opts.all && !nonEmpty(opts.ids) && !nonEmpty(opts.tags) && !nonEmpty(opts.priorities) && !opts.changed) opts.all = true;
  const sel = select(cases, cfg, opts);
  sel.mode = Object.entries({ all: opts.all, ids: opts.ids, tags: opts.tags, priority: opts.priorities, changed: opts.changed && `${opts.changed.length} file(s)` })
    .filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => (v === true ? k : `${k}=${[].concat(v).join(',')}`)).join(' ');
  sel.changedFiles = opts.changed;
  return sel;
}

const outRoot = (cfg) => path.resolve(cfg.root, cfg.outDir);

/** Start a run. Returns { runId, runDir, done } where done resolves to the results data. */
function startRun(cfg, sel, { onResult = () => {} } = {}) {
  const root = outRoot(cfg);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const lastFile = path.join(root, 'last.json');
  const previous = fs.existsSync(lastFile) ? JSON.parse(fs.readFileSync(lastFile, 'utf8')) : null;
  const startedAt = new Date().toISOString();
  const done = (async () => {
    const results = await runAll(sel.selected, cfg, runDir, onResult);
    results.sort((a, b) => a.id.localeCompare(b.id));
    const meta = { project: cfg.name, startedAt, baseUrl: cfg.baseUrl, mode: sel.mode, runId };
    const data = writeReports(cfg, runDir, meta, results, previous);
    fs.writeFileSync(lastFile, JSON.stringify({ meta, runDir, results: results.map(({ id, status }) => ({ id, status })) }));
    return data;
  })();
  return { runId, runDir, done };
}

function listRuns(cfg) {
  const dir = path.join(outRoot(cfg), 'runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'results.json'))).sort().reverse() : [];
}
function runDirOf(cfg, runId) {
  const id = runId || listRuns(cfg)[0];
  if (!id) throw new Error('No runs yet. Run cases first.');
  if (!/^[0-9A-Za-z_.-]+$/.test(id)) throw new Error('Invalid runId');
  return path.join(outRoot(cfg), 'runs', id);
}
function loadRun(cfg, runId) {
  const f = path.join(runDirOf(cfg, runId), 'results.json');
  if (!fs.existsSync(f)) throw new Error(`Run ${runId} has no results (still running or unknown id)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
module.exports = { buildSelection, startRun, listRuns, runDirOf, loadRun };
