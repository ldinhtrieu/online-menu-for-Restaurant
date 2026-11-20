'use strict';
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { walk } = require('./util');

const ACTIONS = new Set(['goto', 'click', 'fill', 'press', 'select', 'check', 'wait', 'waitFor',
  'expectText', 'expectVisible', 'expectHidden', 'expectUrl', 'expectCount', 'screenshot', 'api', 'set']);

/** Load every case. A file may hold one case (mapping) or many (`cases:` list or YAML list). */
function loadCases(cfg) {
  const dir = path.resolve(cfg.root, cfg.casesDir);
  const cases = [];
  const errors = [];
  for (const file of walk(dir, ['.yaml', '.yml'])) {
    let doc;
    try { doc = YAML.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { errors.push(`${rel(cfg, file)}: ${e.message}`); continue; }
    const r = fromDoc(doc, rel(cfg, file));
    cases.push(...r.cases);
    errors.push(...r.errors);
  }
  const seen = new Set();
  for (const c of cases) { if (seen.has(c.id)) errors.push(`Duplicate case id ${c.id}`); seen.add(c.id); }
  return { cases, errors };
}
/** Turn a parsed YAML doc into validated, normalized cases (also used to check AI output). */
function fromDoc(doc, file) {
  const cases = [];
  const errors = [];
  const list = Array.isArray(doc) ? doc : doc && doc.cases ? doc.cases : doc ? [doc] : [];
  const d = doc && !Array.isArray(doc) && doc.cases ? { tags: doc.tags, priority: doc.priority, covers: doc.covers } : {};
  for (const c of list) {
    const norm = normalize(c || {}, d, file);
    const errs = validate(norm);
    if (errs.length) errors.push(`${file} [${norm.id || '?'}]: ${errs.join('; ')}`);
    else cases.push(norm);
  }
  return { cases, errors };
}
const rel = (cfg, f) => path.relative(cfg.root, f).split(path.sep).join('/');

function normalize(c, d, file) {
  return {
    id: c.id, title: c.title || c.id, file,
    priority: c.priority || d.priority || 'P2',
    tags: [...new Set([...(d.tags || []), ...(c.tags || [])])],
    covers: [...(d.covers || []), ...(c.covers || [])],   // source globs this case exercises
    skip: c.skip || false, vars: c.vars || {}, steps: c.steps || [],
    teardown: c.teardown || [],
  };
}
function validate(c) {
  const e = [];
  if (!c.id) e.push('missing id');
  if (!Array.isArray(c.steps) || !c.steps.length) e.push('no steps');
  for (const [i, s] of (c.steps || []).concat(c.teardown || []).entries()) {
    const keys = Object.keys(s || {}).filter((k) => k !== 'name');
    if (keys.length !== 1 || !ACTIONS.has(keys[0])) e.push(`step ${i + 1}: need exactly one action of ${[...ACTIONS].join('/')}`);
  }
  return e;
}
module.exports = { loadCases, fromDoc, ACTIONS };
