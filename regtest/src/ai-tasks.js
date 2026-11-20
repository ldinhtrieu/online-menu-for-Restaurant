'use strict';
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { AI, stripFence } = require('./ai');
const { fromDoc, loadCases } = require('./cases');
const { slug } = require('./util');

const FORMAT_SPEC = `Output ONLY valid YAML (no prose, no code fence). Format:

tags: [<default tags for the file>]
cases:
  - id: <PREFIX-001>            # unique
    title: <short, specific>
    priority: P0|P1|P2|P3       # P0 = business critical
    tags: [<tags>]              # reuse existing tags where they fit
    covers: ["<source glob>"]   # optional: code paths this case exercises
    steps:                      # each step has exactly ONE action key (+ optional name)
      - goto: /path
      - click: "css selector"
      - fill: { selector: "css", value: "text" }
      - press: { selector: "css", key: Enter }
      - select: { selector: "css", value: "x" }
      - check: "css selector"
      - waitFor: "css selector"
      - expectVisible: "css selector"
      - expectHidden: "css selector"
      - expectText: { selector: "css", equals: "exact" }     # or contains: "part"
      - expectCount: { selector: "css", count: 2 }
      - expectUrl: "/part/of/url"
      - api: { method: POST, url: /api/x, body: {..}, expectStatus: 201,
               expectJson: { field: value, id: $exists }, save: { varName: id } }
      - set: { var: value }
    teardown: [ ...steps that always run, e.g. cleanup... ]

Variables: \${name} (from vars/save) and \${env.NAME}. Only the actions above exist.
Cover: happy path, validation/negative cases, boundary values, and regressions of existing behaviour
that the change could affect. Each case must be independent and clean up the data it creates.
If a selector or endpoint is unknown, choose a sensible one and add a YAML comment "# ASSUMPTION: ...".`;

/** regtest gen: ticket/diff text -> draft cases in <draftsDir>, validated, awaiting approval. */
async function gen(cfg, { text, name }) {
  const ai = new AI(cfg);
  const { cases: existing } = loadCases(cfg);
  const context = [
    `Project: ${cfg.name}. Base URL: ${cfg.baseUrl}. API base: ${cfg.apiBaseUrl}.`,
    `Existing tags: ${[...new Set(existing.flatMap((c) => c.tags))].join(', ') || '(none)'}.`,
    `Existing case ids (do not reuse): ${existing.map((c) => c.id).join(', ') || '(none)'}.`,
    `Impact rules (source path -> tag): ${JSON.stringify(cfg.impact)}.`,
  ].join('\n');
  const system = 'You are a QA engineer writing automated regression test cases for a declarative test runner.';
  let prompt = `${context}\n\n${FORMAT_SPEC}\n\n=== INPUT (ticket / change description / diff) ===\n${text}\n=== END INPUT ===`;

  let yamlText = '', errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    yamlText = stripFence(await ai.ask('gen', prompt, { system }));
    errors = [];
    let doc;
    try { doc = YAML.parse(yamlText); } catch (e) { errors.push('YAML parse error: ' + e.message); }
    if (doc) {
      const r = fromDoc(doc, 'draft');
      errors.push(...r.errors);
      const clash = r.cases.filter((c) => existing.some((e) => e.id === c.id)).map((c) => c.id);
      if (clash.length) errors.push('ids already exist: ' + clash.join(', '));
      if (!r.cases.length && !errors.length) errors.push('no cases produced');
    }
    if (!errors.length) break;
    prompt += `\n\n=== YOUR PREVIOUS OUTPUT HAD ERRORS ===\n${errors.join('\n')}\nFix them and output the complete YAML again.`;
  }
  if (errors.length) throw Object.assign(new Error('AI output invalid after retry:\n  ' + errors.join('\n  ')), { ai });
  const dir = path.resolve(cfg.root, cfg.draftsDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(name || 'generated')}.yaml`);
  fs.writeFileSync(file, yamlText + '\n');
  const n = fromDoc(YAML.parse(yamlText), 'draft').cases.length;
  return { file, count: n, ai };
}

/** regtest approve <draft>: validate again and move into casesDir (the human review step). */
function approve(cfg, draft) {
  const src = path.resolve(cfg.root, draft);
  if (!fs.existsSync(src)) throw new Error('Draft not found: ' + src);
  const { cases, errors } = fromDoc(YAML.parse(fs.readFileSync(src, 'utf8')), path.basename(src));
  if (errors.length) throw new Error('Draft invalid:\n  ' + errors.join('\n  '));
  const { cases: existing } = loadCases(cfg);
  const clash = cases.filter((c) => existing.some((e) => e.id === c.id)).map((c) => c.id);
  if (clash.length) throw new Error('ids already exist in cases/: ' + clash.join(', '));
  const dest = path.resolve(cfg.root, cfg.casesDir, path.basename(src));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { dest, count: cases.length };
}

/** Cheap, no-AI triage. Returns a category or null when a human/AI has to look. */
function triage(error) {
  const e = String(error || '');
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|-> 50[234]\b|net::ERR_/.test(e)) return { kind: 'environment', note: 'App/API unreachable or gateway error - check the environment, not the case.' };
  if (/-> 5\d\d\b/.test(e)) return { kind: 'backend-error', note: 'Server returned 5xx - likely a real backend bug.' };
  return null;
}

/** regtest explain: analyse failures of the last run. Only failures that triage cannot settle call the AI. */
async function explain(cfg, runDir) {
  const data = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
  const failed = data.results.filter((r) => r.status === 'failed');
  const ai = new AI(cfg);
  const out = [];
  const needAI = [];
  for (const r of failed) {
    const t = triage(r.error);
    if (t) out.push({ id: r.id, title: r.title, source: 'rule', ...t });
    else needAI.push(r);
  }
  if (needAI.length) {
    // one call for all remaining failures (cheaper than one call per case)
    const items = needAI.map((r) => ({
      id: r.id, title: r.title, regression: !!r.regression, error: (r.error || '').slice(0, 600),
      steps: r.steps.map((s) => `${s.status === 'failed' ? 'FAILED ' : ''}${s.name}`).slice(0, 25),
    }));
    const prompt = `Failed automated regression cases (JSON). For each, decide the most likely cause and a concrete next action.
Categories: "ui-changed" (selector/text changed, update the case), "real-bug" (app behaviour wrong), "data" (test data/state problem), "flaky" (timing), "unknown".
Reply with ONLY a YAML list: - id: ..., kind: ..., note: <one or two sentences>.\n\n${JSON.stringify(items, null, 1)}`;
    const ans = stripFence(await ai.ask('explain', prompt, { useCache: true, system: 'You are a senior QA engineer triaging failed tests. Be brief and concrete.' }));
    let list = [];
    try { list = YAML.parse(ans) || []; } catch { /* fall through */ }
    for (const r of needAI) {
      const m = Array.isArray(list) && list.find((x) => x && x.id === r.id);
      out.push({ id: r.id, title: r.title, source: 'ai', kind: (m && m.kind) || 'unknown', note: (m && m.note) || ans.slice(0, 300) });
    }
  }
  return { results: out, ai, total: failed.length };
}
module.exports = { gen, approve, explain, triage };
