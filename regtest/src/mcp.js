'use strict';
// MCP server (stdio) exposing regtest to an AI client such as GitHub Copilot agent mode.
// The server itself never calls an AI model: the client's model is the AI; regtest supplies the
// deterministic parts (selection, running, validation, reports, drafts/approval).
// IMPORTANT: stdout is the MCP channel. Never console.log here - use stderr.
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { loadConfig } = require('./config');
const { loadCases, fromDoc, ACTIONS } = require('./cases');
const { buildSelection, startRun, listRuns, runDirOf, loadRun } = require('./engine');
const { triage, FORMAT_SPEC } = require('./ai-tasks');
const { slug } = require('./util');
const pkg = require('../package.json');

const MAX_YAML = 200 * 1024;
const MAX_IMAGE = 1.5 * 1024 * 1024;
const clip = (s, n = 800) => (s && s.length > n ? s.slice(0, n) + '…' : s);

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg) }] });
/** Wrap a handler so thrown errors become tool errors instead of protocol errors. */
const safe = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e.message || e); } };

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function createServer(projectDirs) {
  const allowed = new Set(projectDirs.map((d) => path.resolve(d)));
  const active = new Map();              // project root -> run state

  // ---------- project resolution ----------
  const cfgOf = (project) => {
    const dirs = [...allowed];
    if (!dirs.length) throw new Error('No project configured. Start the server with --project <dir> or call regtest_init_project.');
    let dir;
    if (!project) {
      if (dirs.length > 1) throw new Error(`Several projects are configured; pass "project". Call regtest_projects to list them.`);
      dir = dirs[0];
    } else {
      dir = dirs.find((d) => d === path.resolve(project) || path.basename(d) === project);
      if (!dir) for (const d of dirs) { try { if (loadConfig(d).name === project) { dir = d; break; } } catch { /* skip */ } }
      if (!dir) throw new Error(`Unknown project "${project}". Known: ${dirs.map((d) => path.basename(d)).join(', ')}`);
    }
    return loadConfig(dir);             // reloaded every call so edits are picked up
  };
  const casesOf = (cfg) => {
    const r = loadCases(cfg);
    if (r.errors.length) throw new Error('Existing case files have errors:\n' + r.errors.join('\n'));
    return r.cases;
  };
  const inside = (base, target) => { const rel = path.relative(base, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const summaryOf = (c) => ({ id: c.id, title: c.title, priority: c.priority, tags: c.tags, file: c.file, covers: c.covers, skipped: !!c.skip });

  const server = new McpServer({ name: 'regtest', version: pkg.version }, {
    instructions: 'regtest runs regression test cases (web via Playwright + API) and selects which ones to run from the git diff. ' +
      'Typical flow: regtest_authoring_guide -> write YAML -> regtest_validate_cases -> regtest_save_draft -> (human reviews) -> regtest_approve_draft; ' +
      'then regtest_select_cases/regtest_run_cases (changed:true) -> regtest_run_status -> regtest_get_results/regtest_get_failure -> fix with regtest_update_case_file. ' +
      'Never approve drafts or edit existing cases without telling the user what changed.',
  });
  const tool = (name, cfg, handler) => server.registerTool(name, cfg, safe(handler));

  // ---------- projects & config ----------
  tool('regtest_projects', {
    title: 'List regtest projects',
    description: 'List projects this server can use, with base URL and case counts.',
    inputSchema: {}, annotations: RO,
  }, async () => text([...allowed].map((d) => {
    try { const c = loadConfig(d); const r = loadCases(c); return { name: c.name, dir: d, baseUrl: c.baseUrl, cases: r.cases.length, caseErrors: r.errors.length }; }
    catch (e) { return { dir: d, error: e.message }; }
  })));

  tool('regtest_init_project', {
    title: 'Scaffold a regtest project',
    description: 'Create regtest.config.yaml and a sample case in a directory inside the workspace the server was started in, and add it to the project list.',
    inputSchema: { dir: z.string().describe('Directory relative to the server working directory') },
    annotations: WRITE,
  }, async ({ dir }) => {
    const base = process.cwd();
    const target = path.resolve(base, dir);
    if (target !== base && !inside(base, target)) throw new Error('dir must be inside the workspace: ' + base);
    fs.mkdirSync(path.join(target, 'cases'), { recursive: true });
    const created = [];
    const w = (f, t) => { const p = path.join(target, f); if (!fs.existsSync(p)) { fs.writeFileSync(p, t); created.push(f); } };
    w('regtest.config.yaml', `name: ${slug(path.basename(target))}\nbaseUrl: http://localhost:3000\nretries: 1\nworkers: 2\nscreenshots: failure\nalwaysRun: { tags: [smoke] }\nonUnmapped: all\nimpact: []\n`);
    w('cases/sample.yaml', 'id: TC-001\ntitle: Home page loads\npriority: P0\ntags: [smoke]\nsteps:\n  - goto: /\n  - expectVisible: body\n');
    allowed.add(target);
    return text({ dir: target, created });
  });

  tool('regtest_get_config', {
    title: 'Show project config',
    description: 'Show effective config: base URLs, retries/workers, alwaysRun, onUnmapped and impact rules (path glob -> tags). Secrets in headers/vars are masked.',
    inputSchema: { project: z.string().optional() }, annotations: RO,
  }, async ({ project }) => {
    const c = cfgOf(project);
    const mask = (o) => Object.fromEntries(Object.keys(o || {}).map((k) => [k, '***']));
    return text({ name: c.name, root: c.root, baseUrl: c.baseUrl, apiBaseUrl: c.apiBaseUrl, casesDir: c.casesDir, draftsDir: c.draftsDir,
      retries: c.retries, workers: c.workers, timeoutMs: c.timeoutMs, screenshots: c.screenshots, alwaysRun: c.alwaysRun,
      onUnmapped: c.onUnmapped, impact: c.impact, varNames: Object.keys(c.vars || {}), headers: mask(c.headers) });
  });

  tool('regtest_add_impact_rule', {
    title: 'Add an impact rule',
    description: 'Map source path globs (relative to the git root) to case tags in regtest.config.yaml, so changes to those paths select those cases. Comments in the config are preserved. Use [] for tags to declare paths known to be irrelevant.',
    inputSchema: { project: z.string().optional(), paths: z.array(z.string()).min(1), tags: z.array(z.string()) }, annotations: WRITE,
  }, async ({ project, paths, tags }) => {
    const c = cfgOf(project);
    const file = ['regtest.config.yaml', 'regtest.config.yml'].map((f) => path.join(c.root, f)).find(fs.existsSync);
    if (!file) throw new Error('Only YAML configs can be edited by this tool.');
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    const impact = doc.get('impact');
    const rule = doc.createNode({ paths, tags });
    if (impact && impact.items) impact.items.push(rule); else doc.set('impact', doc.createNode([{ paths, tags }]));
    fs.writeFileSync(file, String(doc));
    return text({ added: { paths, tags }, rules: loadConfig(c.root).impact.length });
  });

  // ---------- cases ----------
  tool('regtest_list_cases', {
    title: 'List cases',
    description: 'List test cases (id, title, priority, tags, file). Optionally filter by tag, priority or text.',
    inputSchema: { project: z.string().optional(), tag: z.string().optional(), priority: z.string().optional(), query: z.string().optional() },
    annotations: RO,
  }, async ({ project, tag, priority, query }) => {
    let cs = casesOf(cfgOf(project));
    if (tag) cs = cs.filter((c) => c.tags.includes(tag));
    if (priority) cs = cs.filter((c) => c.priority === priority);
    if (query) cs = cs.filter((c) => (c.id + ' ' + c.title).toLowerCase().includes(query.toLowerCase()));
    return text({ count: cs.length, cases: cs.map(summaryOf) });
  });

  tool('regtest_get_case', {
    title: 'Get a case',
    description: 'Return a case (normalized, with steps) and the raw YAML of the file that contains it.',
    inputSchema: { project: z.string().optional(), id: z.string() }, annotations: RO,
  }, async ({ project, id }) => {
    const c = cfgOf(project);
    const cs = casesOf(c).find((x) => x.id === id);
    if (!cs) throw new Error(`Case ${id} not found`);
    return text({ case: cs, file: cs.file, yaml: fs.readFileSync(path.join(c.root, cs.file), 'utf8') });
  });

  tool('regtest_select_cases', {
    title: 'Select cases to run (dry run)',
    description: 'Show which cases would run and WHY, without running. Use changed:true (or a base ref like "origin/main") to select by git diff using impact rules; files lets you pass changed files explicitly. Unmapped changed files make everything run unless config onUnmapped is "ignore".',
    inputSchema: selectionShape(), annotations: RO,
  }, async (a) => {
    const c = cfgOf(a.project);
    const sel = buildSelection(c, casesOf(c), toSpec(a));
    return text({ mode: sel.mode, changedFiles: sel.changedFiles, impactedTags: sel.impactedTags, unmappedFiles: sel.unmapped, notes: sel.notes,
      selected: sel.selected.map((s) => ({ id: s.case.id, title: s.case.title, priority: s.case.priority, reasons: s.reasons })) });
  });

  // ---------- running ----------
  tool('regtest_run_cases', {
    title: 'Run cases',
    description: 'Run selected cases (same selection options as regtest_select_cases). By default it starts in the background and returns a runId: poll regtest_run_status. Set waitSeconds (max 300) to wait for completion in this call. Only one run per project at a time. Requires the app under test to be reachable at the project baseUrl.',
    inputSchema: { ...selectionShape(), workers: z.number().int().min(1).max(8).optional(), retries: z.number().int().min(0).max(3).optional(),
      screenshots: z.enum(['all', 'failure', 'none']).optional(), waitSeconds: z.number().int().min(0).max(300).optional() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async (a) => {
    const c = cfgOf(a.project);
    const cur = active.get(c.root);
    if (cur && cur.state === 'running') throw new Error(`A run is already in progress for this project: ${cur.runId}. Use regtest_run_status.`);
    if (a.workers) c.workers = a.workers;
    if (a.retries !== undefined) c.retries = a.retries;
    if (a.screenshots) c.screenshots = a.screenshots;
    const sel = buildSelection(c, casesOf(c), toSpec(a));
    if (!sel.selected.length) return text({ started: false, message: 'No cases selected.', notes: sel.notes, mode: sel.mode });
    const st = { runId: null, state: 'running', total: sel.selected.length, finished: [], mode: sel.mode, error: null };
    const run = startRun(c, sel, { onResult: (r) => st.finished.push({ id: r.id, status: r.status, flaky: r.flaky, ms: r.ms }) });
    st.runId = run.runId;
    st.done = run.done.then((d) => { st.state = 'done'; st.summary = d.summary; return d; }, (e) => { st.state = 'error'; st.error = e.message; });
    active.set(c.root, st);
    if (a.waitSeconds) await Promise.race([st.done, new Promise((r) => setTimeout(r, a.waitSeconds * 1000))]);
    return text(statusOf(c, st));
  });

  const statusOf = (c, st) => ({ runId: st.runId, state: st.state, mode: st.mode, progress: `${st.finished.length}/${st.total}`,
    failedSoFar: st.finished.filter((f) => f.status === 'failed').map((f) => f.id), summary: st.summary, error: st.error,
    report: st.state === 'done' ? path.join(runDirOf(c, st.runId), 'report.html') : undefined });

  tool('regtest_run_status', {
    title: 'Run status',
    description: 'Status of the current (or a past) run: running/done, progress, failures so far, summary and report path.',
    inputSchema: { project: z.string().optional(), runId: z.string().optional(), waitSeconds: z.number().int().min(0).max(120).optional().describe('Block up to N seconds for completion') },
    annotations: RO,
  }, async ({ project, runId, waitSeconds }) => {
    const c = cfgOf(project);
    const st = active.get(c.root);
    if (st && (!runId || runId === st.runId)) {
      if (waitSeconds && st.state === 'running') await Promise.race([st.done, new Promise((r) => setTimeout(r, waitSeconds * 1000))]);
      return text(statusOf(c, st));
    }
    const d = loadRun(c, runId);
    return text({ runId: d.meta.runId || path.basename(runDirOf(c, runId)), state: 'done', mode: d.meta.mode, summary: d.summary, report: path.join(runDirOf(c, runId), 'report.html') });
  });

  tool('regtest_list_runs', {
    title: 'List past runs', description: 'List recent runs (newest first) with pass/fail summary.',
    inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: RO,
  }, async ({ project, limit }) => {
    const c = cfgOf(project);
    return text(listRuns(c).slice(0, limit || 10).map((id) => { const d = loadRun(c, id); return { runId: id, startedAt: d.meta.startedAt, mode: d.meta.mode, ...d.summary }; }));
  });

  tool('regtest_get_results', {
    title: 'Get run results',
    description: 'Results per case for a run (default: latest). Failed cases include the error and (with includeSteps) their steps. REGRESSION means it passed in the previous run; FLAKY means it passed only after a retry.',
    inputSchema: { project: z.string().optional(), runId: z.string().optional(), status: z.enum(['all', 'failed', 'passed']).optional(), includeSteps: z.boolean().optional() },
    annotations: RO,
  }, async ({ project, runId, status, includeSteps }) => {
    const c = cfgOf(project);
    const d = loadRun(c, runId);
    const rs = d.results.filter((r) => !status || status === 'all' || r.status === status);
    return text({ meta: d.meta, summary: d.summary, report: path.join(runDirOf(c, runId), 'report.html'),
      results: rs.map((r) => ({ id: r.id, title: r.title, status: r.status, priority: r.priority, flaky: r.flaky, regression: r.regression,
        attempts: r.attempts, ms: r.ms, selectedBecause: r.reasons, error: clip(r.error),
        steps: includeSteps ? r.steps.map((s) => ({ name: s.name, status: s.status, error: clip(s.error, 400), hasScreenshot: !!s.screenshot })) : undefined })) });
  });

  tool('regtest_get_failure', {
    title: 'Get one failure in detail',
    description: 'Steps, error, rule-based triage and the screenshot of the failing step (as an image) for one failed case.',
    inputSchema: { project: z.string().optional(), runId: z.string().optional(), caseId: z.string(), includeScreenshot: z.boolean().optional() },
    annotations: RO,
  }, async ({ project, runId, caseId, includeScreenshot }) => {
    const c = cfgOf(project);
    const d = loadRun(c, runId);
    const r = d.results.find((x) => x.id === caseId);
    if (!r) throw new Error(`Case ${caseId} not in this run`);
    const out = [{ type: 'text', text: JSON.stringify({ id: r.id, title: r.title, status: r.status, regression: r.regression, flaky: r.flaky, error: r.error,
      triage: triage(r.error), steps: r.steps.map((s) => ({ name: s.name, status: s.status, error: clip(s.error, 600) })) }, null, 2) }];
    const bad = r.steps.find((s) => s.status === 'failed' && s.screenshot);
    if (bad && includeScreenshot !== false) {
      const f = path.join(runDirOf(c, runId), bad.screenshot);
      if (inside(runDirOf(c, runId), f) && fs.existsSync(f) && fs.statSync(f).size <= MAX_IMAGE)
        out.push({ type: 'image', data: fs.readFileSync(f).toString('base64'), mimeType: 'image/png' });
    }
    return { content: out };
  });

  tool('regtest_triage_failures', {
    title: 'Triage failures',
    description: 'Classify failures of a run. Rules settle environment problems (app unreachable, gateway errors) and backend 5xx. The rest are returned as "needsAnalysis" with compact evidence for YOU to judge: ui-changed (update the case), real-bug, data, flaky.',
    inputSchema: { project: z.string().optional(), runId: z.string().optional() }, annotations: RO,
  }, async ({ project, runId }) => {
    const d = loadRun(cfgOf(project), runId);
    const failed = d.results.filter((r) => r.status === 'failed');
    const byRule = [], needsAnalysis = [];
    for (const r of failed) {
      const t = triage(r.error);
      if (t) byRule.push({ id: r.id, ...t });
      else needsAnalysis.push({ id: r.id, title: r.title, regression: !!r.regression, error: clip(r.error, 600),
        steps: r.steps.map((s) => `${s.status === 'failed' ? 'FAILED ' : ''}${s.name}`).slice(0, 25) });
    }
    return text({ failed: failed.length, byRule, needsAnalysis,
      categories: ['ui-changed', 'real-bug', 'data', 'flaky', 'unknown'],
      hint: 'A case that failed because its selector/text no longer matches while the app works is ui-changed: fix it with regtest_update_case_file. Do not "fix" a real-bug by weakening assertions.' });
  });

  // ---------- authoring ----------
  tool('regtest_authoring_guide', {
    title: 'Case authoring guide',
    description: 'Everything needed to write valid cases for this project: YAML format and actions, existing tags and ids (avoid clashes), impact rules and base URLs. Call before writing cases.',
    inputSchema: { project: z.string().optional() }, annotations: RO,
  }, async ({ project }) => {
    const c = cfgOf(project);
    const cs = casesOf(c);
    return text({ format: FORMAT_SPEC, actions: [...ACTIONS], project: { name: c.name, baseUrl: c.baseUrl, apiBaseUrl: c.apiBaseUrl },
      existingTags: [...new Set(cs.flatMap((x) => x.tags))], existingIds: cs.map((x) => x.id), impactRules: c.impact,
      examples: cs.slice(0, 2).map((x) => ({ id: x.id, steps: x.steps })),
      rules: ['Output must pass regtest_validate_cases.', 'Each case independent; clean up created data in teardown.', 'Mark guesses with "# ASSUMPTION:" comments.',
        'Save with regtest_save_draft; a human approves before it joins the suite.'] });
  });

  const parseYaml = (y) => {
    if (typeof y !== 'string' || !y.trim()) throw new Error('yaml is empty');
    if (y.length > MAX_YAML) throw new Error('yaml too large');
    try { return YAML.parse(y); } catch (e) { throw new Error('YAML parse error: ' + e.message); }
  };
  const check = (c, yamlText, { ignoreFile } = {}) => {
    const r = fromDoc(parseYaml(yamlText), 'candidate');
    const errors = [...r.errors];
    const existing = loadCases(c).cases.filter((x) => x.file !== ignoreFile);
    const clash = r.cases.filter((x) => existing.some((e) => e.id === x.id)).map((x) => x.id);
    if (clash.length) errors.push('ids already exist: ' + clash.join(', '));
    const dup = r.cases.map((x) => x.id).filter((id, i, a) => a.indexOf(id) !== i);
    if (dup.length) errors.push('duplicate ids inside the file: ' + [...new Set(dup)].join(', '));
    if (!r.cases.length && !errors.length) errors.push('no cases found');
    return { cases: r.cases, errors };
  };

  tool('regtest_validate_cases', {
    title: 'Validate case YAML',
    description: 'Check YAML against the case format and existing ids without saving anything.',
    inputSchema: { project: z.string().optional(), yaml: z.string() }, annotations: RO,
  }, async ({ project, yaml }) => {
    const r = check(cfgOf(project), yaml);
    return text({ valid: !r.errors.length, errors: r.errors, cases: r.cases.map(summaryOf) });
  });

  tool('regtest_save_draft', {
    title: 'Save drafted cases',
    description: 'Validate and write cases to the drafts folder. Drafts do NOT run until a human approves them (regtest_approve_draft).',
    inputSchema: { project: z.string().optional(), name: z.string().min(1).max(80), yaml: z.string() }, annotations: WRITE,
  }, async ({ project, name, yaml }) => {
    const c = cfgOf(project);
    const r = check(c, yaml);
    if (r.errors.length) return fail('Invalid draft:\n' + r.errors.join('\n'));
    const dir = path.resolve(c.root, c.draftsDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, slug(name).replace(/\.ya?ml$/i, '') + '.yaml');
    fs.writeFileSync(file, yaml.endsWith('\n') ? yaml : yaml + '\n');
    return text({ saved: path.relative(c.root, file), cases: r.cases.map((x) => x.id), next: 'Ask the user to review, then call regtest_approve_draft.' });
  });

  tool('regtest_list_drafts', {
    title: 'List drafts', description: 'List draft files waiting for approval, with their case ids (optionally the YAML).',
    inputSchema: { project: z.string().optional(), includeContent: z.boolean().optional() }, annotations: RO,
  }, async ({ project, includeContent }) => {
    const c = cfgOf(project);
    const dir = path.resolve(c.root, c.draftsDir);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
    return text(files.map((f) => {
      const y = fs.readFileSync(path.join(dir, f), 'utf8');
      let ids = []; try { ids = fromDoc(YAML.parse(y), f).cases.map((x) => x.id); } catch { /* invalid */ }
      return { name: f, ids, yaml: includeContent ? y : undefined };
    }));
  });

  tool('regtest_approve_draft', {
    title: 'Approve a draft',
    description: 'Re-validate a draft and move it into the cases folder so it joins the regression suite. Only call after the user has reviewed the draft.',
    inputSchema: { project: z.string().optional(), name: z.string() }, annotations: WRITE,
  }, async ({ project, name }) => {
    const c = cfgOf(project);
    const src = path.resolve(c.root, c.draftsDir, path.basename(name));
    if (!inside(path.resolve(c.root, c.draftsDir), src) || !fs.existsSync(src)) throw new Error('Draft not found: ' + name);
    const r = check(c, fs.readFileSync(src, 'utf8'));
    if (r.errors.length) throw new Error('Draft invalid:\n' + r.errors.join('\n'));
    const dest = path.resolve(c.root, c.casesDir, path.basename(src));
    if (fs.existsSync(dest)) throw new Error('A cases file with this name already exists: ' + path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return text({ approved: r.cases.map((x) => x.id), file: path.relative(c.root, dest) });
  });

  tool('regtest_update_case_file', {
    title: 'Update an existing case file',
    description: 'Replace the content of an existing file in the cases folder (e.g. to fix a selector after a UI change). The new YAML is validated first. Tell the user what changed; git keeps history.',
    inputSchema: { project: z.string().optional(), file: z.string().describe('Path of the case file, as shown in the "file" field of regtest_list_cases'), yaml: z.string() },
    annotations: WRITE,
  }, async ({ project, file, yaml }) => {
    const c = cfgOf(project);
    const abs = path.resolve(c.root, file);
    const casesDir = path.resolve(c.root, c.casesDir);
    if (!inside(casesDir, abs) || !/\.ya?ml$/.test(abs) || !fs.existsSync(abs)) throw new Error('file must be an existing .yaml inside ' + c.casesDir);
    const r = check(c, yaml, { ignoreFile: path.relative(c.root, abs).split(path.sep).join('/') });
    if (r.errors.length) return fail('Invalid YAML, nothing written:\n' + r.errors.join('\n'));
    const before = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, yaml.endsWith('\n') ? yaml : yaml + '\n');
    return text({ updated: file, cases: r.cases.map((x) => x.id), bytesBefore: before.length, bytesAfter: yaml.length });
  });

  // ---------- prompts (workflows the user can pick in Copilot Chat) ----------
  const userMsg = (t) => ({ messages: [{ role: 'user', content: { type: 'text', text: t } }] });
  server.registerPrompt('regression_for_change', {
    title: 'Run regression for my change',
    description: 'Select and run the regression cases impacted by the current git changes, then triage failures.',
    argsSchema: { base: z.string().optional().describe('Base ref, e.g. origin/main (default: working tree changes)'), project: z.string().optional() },
  }, ({ base, project }) => userMsg(`Run the regression for my current changes using the regtest tools${project ? ` (project: ${project})` : ''}.
1. regtest_select_cases with changed=${base ? `"${base}"` : 'true'} and show me which cases were selected and why; warn me about unmapped files.
2. regtest_run_cases with the same selection, then poll regtest_run_status until done.
3. If anything failed: regtest_triage_failures, then regtest_get_failure for each case that needs analysis. Report real bugs, regressions and flaky cases separately.
4. Propose (do not apply without asking) fixes for cases that failed only because the UI changed.`));
  server.registerPrompt('generate_cases', {
    title: 'Generate regression cases from a ticket/diff',
    description: 'Draft test cases for a ticket or change description and save them as a draft for review.',
    argsSchema: { input: z.string().describe('Ticket text, change description or diff'), project: z.string().optional() },
  }, ({ input, project }) => userMsg(`Write regression test cases for the following change, using the regtest tools${project ? ` (project: ${project})` : ''}.
1. Call regtest_authoring_guide and follow its format exactly; reuse existing tags; do not reuse ids.
2. Cover happy path, validation/negative, boundaries, and existing behaviour the change could break (regression). Mark guesses with "# ASSUMPTION:".
3. regtest_validate_cases; fix errors until valid; then regtest_save_draft.
4. Show me a summary of the cases and ask me to review before calling regtest_approve_draft. If new source paths need mapping, suggest regtest_add_impact_rule.

=== INPUT ===
${input}`));
  server.registerPrompt('fix_failing_cases', {
    title: 'Investigate and fix failing cases',
    description: 'Triage the last run and fix cases broken by UI changes (not real bugs).',
    argsSchema: { runId: z.string().optional(), project: z.string().optional() },
  }, ({ runId, project }) => userMsg(`Investigate failures of ${runId ? 'run ' + runId : 'the latest run'} with regtest${project ? ` (project: ${project})` : ''}.
Use regtest_triage_failures and regtest_get_failure (look at the screenshot). For each failure say: ui-changed / real-bug / data / flaky, with evidence.
For ui-changed only: show me the corrected YAML and apply with regtest_update_case_file after I agree, then re-run just those ids with regtest_run_cases.
Never loosen assertions to make a real bug pass.`));

  return server;
}

async function main(argv) {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--project' && argv[i + 1]) dirs.push(argv[++i]);
  if (process.env.REGTEST_PROJECTS) dirs.push(...process.env.REGTEST_PROJECTS.split(path.delimiter).filter(Boolean));
  if (!dirs.length && fs.existsSync(path.join(process.cwd(), 'regtest.config.yaml'))) dirs.push(process.cwd());
  const server = createServer(dirs);
  await server.connect(new StdioServerTransport());
  console.error(`regtest MCP server ready (${dirs.length} project(s): ${dirs.join(', ') || 'none'})`);
}

function selectionShape() {
  return {
    project: z.string().optional().describe('Project name or dir (needed only when several are configured)'),
    all: z.boolean().optional(), ids: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), priorities: z.array(z.string()).optional(),
    changed: z.union([z.boolean(), z.string()]).optional().describe('true = git changes (working tree); string = base ref, e.g. "origin/main"'),
    files: z.array(z.string()).optional().describe('Explicit changed files (relative to git root) instead of reading git'),
  };
}
function toSpec(a) {
  return { all: a.all, ids: a.ids, tags: a.tags, priorities: a.priorities, files: a.files, changed: a.changed === false ? undefined : a.changed };
}

module.exports = { createServer, main };
