'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { runStep } = require('./steps');
const { slug } = require('./util');

const label = (s) => { const a = Object.keys(s).find((k) => k !== 'name'); const v = s[a];
  return s.name || `${a} ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 140); };

async function runCase(c, cfg, browserGetter, runDir) {
  const t0 = Date.now();
  const ctx = { cfg, vars: { ...cfg.vars, ...c.vars }, page: null, steps: [] };
  const needsBrowser = c.steps.concat(c.teardown).some((s) => ['goto', 'click', 'fill', 'press', 'select', 'check', 'waitFor', 'expect' + 'Text', 'expectVisible', 'expectHidden', 'expectUrl', 'expectCount', 'screenshot'].some((k) => k in s));
  let context = null;
  const shotDir = path.join(runDir, 'shots', slug(c.id)); let shotN = 0;
  ctx.newPage = async () => { const b = await browserGetter(); context = await b.newContext({ viewport: { width: 1280, height: 800 } }); return context.newPage(); };
  ctx.shot = async (page, name) => {
    fs.mkdirSync(shotDir, { recursive: true });
    const f = `${String(++shotN).padStart(2, '0')}-${slug(name)}.png`;
    try { await page.screenshot({ path: path.join(shotDir, f) }); return path.posix.join('shots', slug(c.id), f); } catch { return null; }
  };
  let error = null;
  const exec = async (list, phase) => {
    for (const s of list) {
      const st = { name: label(s), phase, status: 'passed', ms: 0 }; const s0 = Date.now();
      try { await runStep(s, ctx); }
      catch (e) { st.status = 'failed'; st.error = e.message; error = error || `${st.name}: ${e.message}`; }
      st.ms = Date.now() - s0;
      if (ctx.page && (st.status === 'failed' ? cfg.screenshots !== 'none' : cfg.screenshots === 'all')) st.screenshot = await ctx.shot(ctx.page, st.status === 'failed' ? 'FAILED-' + st.name : st.name);
      ctx.steps.push(st);
      if (st.status === 'failed' && phase === 'steps') return false;
    }
    return true;
  };
  try { await exec(c.steps, 'steps'); await exec(c.teardown, 'teardown'); }
  finally { if (context) await context.close().catch(() => {}); }
  return { status: error ? 'failed' : 'passed', error, steps: ctx.steps, ms: Date.now() - t0, usesBrowser: needsBrowser };
}

/** Run selected cases with retries and a worker pool. onResult is called as each case completes. */
async function runAll(selected, cfg, runDir, onResult = () => {}) {
  let browser = null, launching = null;
  const getBrowser = async () => {
    if (browser) return browser;
    launching = launching || chromium.launch({ headless: cfg.headless, executablePath: cfg.browser.executablePath, args: cfg.browser.args });
    return (browser = await launching);
  };
  const results = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const i = next++; const { case: c, reasons } = selected[i];
      const attempts = []; let r;
      for (let a = 0; a <= cfg.retries; a++) {
        r = await runCase(c, cfg, getBrowser, path.join(runDir, `attempt${a + 1}`)); attempts.push(r.status);
        if (r.status === 'passed') break;
      }
      const attemptDir = `attempt${attempts.length}`;
      const fix = (p) => p && path.posix.join(attemptDir, p);
      r.steps.forEach((s) => { s.screenshot = fix(s.screenshot); });
      results[i] = { id: c.id, title: c.title, priority: c.priority, tags: c.tags, file: c.file, reasons, ...r,
        attempts: attempts.length, flaky: r.status === 'passed' && attempts.length > 1 };
      onResult(results[i]);
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.workers, selected.length)) }, worker)); }
  finally { if (browser) await browser.close(); }
  return results;
}
module.exports = { runAll };
