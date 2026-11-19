'use strict';
const fs = require('fs');
const path = require('path');
const { esc } = require('./util');

function summarize(results) {
  const s = { total: results.length, passed: 0, failed: 0, flaky: 0, ms: 0 };
  for (const r of results) { r.status === 'passed' ? s.passed++ : s.failed++; if (r.flaky) s.flaky++; s.ms += r.ms; }
  return s;
}

function writeReports(cfg, runDir, meta, results, previous) {
  const summary = summarize(results);
  const prevStatus = new Map((previous ? previous.results : []).map((r) => [r.id, r.status]));
  results.forEach((r) => { r.regression = r.status === 'failed' && prevStatus.get(r.id) === 'passed'; });
  const data = { meta, summary, results };
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(runDir, 'junit.xml'), junit(cfg, results));
  fs.writeFileSync(path.join(runDir, 'report.html'), html(meta, summary, results));
  return data;
}

function junit(cfg, results) {
  const f = results.filter((r) => r.status === 'failed').length;
  const cases = results.map((r) => `<testcase classname="${esc(r.file)}" name="${esc(r.id + ' ' + r.title)}" time="${(r.ms / 1000).toFixed(2)}">` +
    (r.status === 'failed' ? `<failure message="${esc(r.error || '')}"/>` : '') + '</testcase>').join('');
  return `<?xml version="1.0"?><testsuite name="${esc(cfg.name)}" tests="${results.length}" failures="${f}">${cases}</testsuite>`;
}

function html(meta, s, results) {
  const rows = results.slice().sort((a, b) => (a.status === b.status ? 0 : a.status === 'failed' ? -1 : 1)).map((r) => {
    const steps = r.steps.map((st) => `<li class="${st.status}"><span>${esc(st.name)}</span> <em>${st.ms}ms</em>` +
      (st.error ? `<pre>${esc(st.error)}</pre>` : '') + (st.screenshot ? `<a href="${esc(st.screenshot)}" target="_blank"><img loading="lazy" src="${esc(st.screenshot)}"></a>` : '') + '</li>').join('');
    const badges = [r.regression ? '<b class="b red">REGRESSION</b>' : '', r.flaky ? '<b class="b amber">FLAKY</b>' : '', r.attempts > 1 && !r.flaky ? `<b class="b">${r.attempts} attempts</b>` : ''].join('');
    return `<details ${r.status === 'failed' ? 'open' : ''} class="${r.status}"><summary><span class="dot"></span><code>${esc(r.id)}</code> ${esc(r.title)} <small>${esc(r.priority)} · ${esc(r.tags.join(', '))} · ${r.ms}ms</small> ${badges}</summary>
      <p class="why">Selected because: ${esc(r.reasons.join(', '))}</p>${r.error ? `<pre class="err">${esc(r.error)}</pre>` : ''}<ol>${steps}</ol></details>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>regtest · ${esc(meta.project)}</title><style>
body{font:14px system-ui;margin:0;background:#f6f7f9;color:#1c2024}header{background:#fff;padding:16px 24px;border-bottom:1px solid #e2e5e9}
h1{margin:0 0 4px;font-size:18px}main{padding:16px 24px;max-width:1100px}.sum span{display:inline-block;margin-right:16px;font-weight:600}
.ok{color:#188038}.bad{color:#c5221f}.warn{color:#b06000}details{background:#fff;border:1px solid #e2e5e9;border-radius:8px;margin:8px 0;padding:8px 12px}
summary{cursor:pointer}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:#188038}.failed .dot{background:#c5221f}
small{color:#6b7280;margin-left:6px}.why{color:#6b7280;font-size:12px;margin:4px 0}ol{padding-left:20px}li{margin:4px 0}li.failed>span{color:#c5221f;font-weight:600}
li em{color:#9aa0a6;font-size:12px}pre{background:#1e1e1e;color:#f5f5f5;padding:8px;border-radius:6px;white-space:pre-wrap}img{display:block;max-width:420px;border:1px solid #ddd;margin:4px 0;border-radius:4px}
.b{font-size:11px;padding:1px 6px;border-radius:8px;background:#eef;margin-left:6px}.red{background:#fce8e6;color:#c5221f}.amber{background:#fef7e0;color:#b06000}</style>
<header><h1>regtest · ${esc(meta.project)}</h1><div class="sum"><span>${s.total} cases</span><span class="ok">${s.passed} passed</span><span class="bad">${s.failed} failed</span><span class="warn">${s.flaky} flaky</span><span>${(s.ms / 1000).toFixed(1)}s</span></div>
<div style="color:#6b7280;margin-top:4px">${esc(meta.startedAt)} · base ${esc(meta.baseUrl)} · mode: ${esc(meta.mode)}</div></header><main>${rows}</main>`;
}
module.exports = { writeReports, summarize };
