'use strict';
const assert = require('assert');
const { interpolate, getPath } = require('./util');

const abs = (base, u) => (/^https?:\/\//.test(u) ? u : base.replace(/\/$/, '') + '/' + String(u).replace(/^\//, ''));
const sel = (v) => (typeof v === 'string' ? { selector: v } : v);

function matchJson(actual, expected, where = '$') {
  if (expected === '$exists') { assert.ok(actual !== undefined && actual !== null, `${where} should exist`); return; }
  if (expected === '$absent') { assert.ok(actual === undefined || actual === null, `${where} should be absent`); return; }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$contains' in expected) { assert.ok(String(actual).includes(expected.$contains), `${where}: ${JSON.stringify(actual)} should contain "${expected.$contains}"`); return; }
    if ('$gt' in expected) { assert.ok(actual > expected.$gt, `${where}: ${actual} should be > ${expected.$gt}`); return; }
    if ('$regex' in expected) { assert.ok(new RegExp(expected.$regex).test(String(actual)), `${where}: ${actual} should match /${expected.$regex}/`); return; }
    for (const [k, v] of Object.entries(expected)) matchJson(actual == null ? undefined : actual[k], v, `${where}.${k}`);
    return;
  }
  assert.deepStrictEqual(actual, expected, `${where}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

/** Execute one step. ctx: { cfg, page, vars, newPage } */
async function runStep(step, ctx) {
  const action = Object.keys(step).find((k) => k !== 'name');
  const arg = interpolate(step[action], ctx.vars);
  const { cfg } = ctx;
  const t = { timeout: cfg.timeoutMs };
  const needPage = async () => ctx.page || (ctx.page = await ctx.newPage());
  switch (action) {
    case 'goto': { const p = await needPage(); await p.goto(abs(cfg.baseUrl, arg), { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs }); break; }
    case 'click': await (await needPage()).click(sel(arg).selector, t); break;
    case 'fill': await (await needPage()).fill(arg.selector, String(arg.value), t); break;
    case 'press': await (await needPage()).press(arg.selector || 'body', arg.key, t); break;
    case 'select': await (await needPage()).selectOption(arg.selector, arg.value, t); break;
    case 'check': await (await needPage()).check(sel(arg).selector, t); break;
    case 'wait': await new Promise((r) => setTimeout(r, Number(arg))); break;
    case 'waitFor': await (await needPage()).waitForSelector(sel(arg).selector, t); break;
    case 'expectVisible': await (await needPage()).waitForSelector(sel(arg).selector, { ...t, state: 'visible' }); break;
    case 'expectHidden': await (await needPage()).waitForSelector(sel(arg).selector, { ...t, state: 'hidden' }); break;
    case 'expectText': {
      const p = await needPage(); const loc = p.locator(arg.selector).first();
      await loc.waitFor({ ...t, state: 'attached' });
      const deadline = Date.now() + cfg.timeoutMs; let txt = '';
      do { txt = (await loc.innerText()).trim(); if (arg.equals !== undefined ? txt === String(arg.equals) : txt.includes(String(arg.text ?? arg.contains))) return;
           await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < deadline);
      throw new Error(`Text of ${arg.selector} is "${txt}", expected ${arg.equals !== undefined ? 'equals' : 'to contain'} "${arg.equals ?? arg.text ?? arg.contains}"`);
    }
    case 'expectCount': {
      const p = await needPage(); const deadline = Date.now() + cfg.timeoutMs; let n;
      do { n = await p.locator(arg.selector).count(); if (n === Number(arg.count)) return; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < deadline);
      throw new Error(`Count of ${arg.selector} is ${n}, expected ${arg.count}`);
    }
    case 'expectUrl': {
      const p = await needPage(); const deadline = Date.now() + cfg.timeoutMs;
      do { if (p.url().includes(String(arg))) return; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < deadline);
      throw new Error(`URL is ${p.url()}, expected to contain "${arg}"`);
    }
    case 'screenshot': { const p = await needPage(); ctx.manualShot = true; await ctx.shot(p, arg && arg.name ? arg.name : 'manual'); break; }
    case 'set': Object.assign(ctx.vars, arg); break;
    case 'api': {
      const headers = { ...cfg.headers, ...(arg.headers || {}) };
      let body = arg.body;
      if (body !== undefined && typeof body === 'object') { body = JSON.stringify(body); headers['content-type'] = headers['content-type'] || 'application/json'; }
      const res = await fetch(abs(cfg.apiBaseUrl, arg.url), { method: arg.method || 'GET', headers, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* not json */ }
      const expectStatus = arg.expectStatus ?? 200;
      const okStatus = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === Number(expectStatus);
      if (!okStatus) throw new Error(`${arg.method || 'GET'} ${arg.url} -> ${res.status}, expected ${expectStatus}. Body: ${text.slice(0, 300)}`);
      if (arg.expectJson) matchJson(json, arg.expectJson);
      for (const [name, p] of Object.entries(arg.save || {})) {
        const v = getPath(json, p); if (v === undefined) throw new Error(`save.${name}: path "${p}" not found in response`); ctx.vars[name] = v;
      }
      if (arg.saveHeader) for (const [name, h] of Object.entries(arg.saveHeader)) ctx.vars[name] = res.headers.get(h);
      break;
    }
    default: throw new Error(`Unknown action ${action}`);
  }
}
module.exports = { runStep, matchJson };
