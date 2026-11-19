'use strict';
const { execFileSync } = require('child_process');
const { matchesAny } = require('./util');

function gitChangedFiles(cwd, base) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const files = new Set();
  // committed changes since merge-base, plus staged/unstaged/untracked
  if (base) { try { run(['diff', '--name-only', `${base}...HEAD`]).forEach((f) => files.add(f)); }
              catch { run(['diff', '--name-only', base]).forEach((f) => files.add(f)); } }
  run(['diff', '--name-only', 'HEAD']).forEach((f) => files.add(f));
  run(['ls-files', '--others', '--exclude-standard', '--full-name']).forEach((f) => files.add(f));
  return { files: [...files].sort(), top };
}

/**
 * Decide which cases to run.
 * opts: { ids, tags, priorities, changed: string[] | null, all }
 * Returns { selected: [{case, reasons}], impactedTags, unmapped, notes }
 */
function select(cases, cfg, opts = {}) {
  const reasons = new Map(); // id -> Set
  const add = (c, r) => { if (!reasons.has(c.id)) reasons.set(c.id, new Set()); reasons.get(c.id).add(r); };
  const notes = [];
  let impactedTags = new Set(), unmapped = [];

  const live = cases.filter((c) => !c.skip);
  if (opts.all) live.forEach((c) => add(c, 'all'));
  if (opts.ids && opts.ids.length) live.filter((c) => opts.ids.includes(c.id)).forEach((c) => add(c, 'id'));
  if (opts.tags && opts.tags.length) live.filter((c) => c.tags.some((t) => opts.tags.includes(t))).forEach((c) => add(c, `tag:${opts.tags.join('|')}`));
  if (opts.priorities && opts.priorities.length) live.filter((c) => opts.priorities.includes(c.priority)).forEach((c) => add(c, `priority:${opts.priorities.join('|')}`));

  if (opts.changed) {
    for (const f of opts.changed) {
      let hit = false;
      for (const rule of cfg.impact) {
        if (matchesAny(f, rule.paths)) { hit = true; (rule.tags || []).forEach((t) => impactedTags.add(t)); }
      }
      for (const c of live) if (matchesAny(f, c.covers)) { hit = true; add(c, `covers:${f}`); }
      if (!hit) unmapped.push(f);
    }
    for (const c of live) for (const t of c.tags) if (impactedTags.has(t)) add(c, `impact:${t}`);
    // baseline: always-run cases protect against changes we cannot map
    for (const c of live) {
      if (c.tags.some((t) => cfg.alwaysRun.tags.includes(t))) add(c, 'alwaysRun:tag');
      if (cfg.alwaysRun.priorities.includes(c.priority)) add(c, 'alwaysRun:priority');
    }
    if (unmapped.length && cfg.onUnmapped === 'all') {
      notes.push(`${unmapped.length} changed file(s) match no impact rule -> running ALL cases (set onUnmapped: ignore to disable)`);
      live.forEach((c) => add(c, 'unmapped-change'));
    }
    if (!opts.changed.length) notes.push('No changed files detected.');
  }
  const selected = live.filter((c) => reasons.has(c.id)).map((c) => ({ case: c, reasons: [...reasons.get(c.id)] }));
  return { selected, impactedTags: [...impactedTags].sort(), unmapped, notes };
}
module.exports = { select, gitChangedFiles };
