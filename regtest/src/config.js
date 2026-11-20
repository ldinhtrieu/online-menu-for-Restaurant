'use strict';
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = {
  name: 'project',
  baseUrl: 'http://localhost:3000',
  apiBaseUrl: null,            // defaults to baseUrl
  casesDir: 'cases',
  outDir: '.regtest',
  retries: 1,
  workers: 2,
  timeoutMs: 15000,
  screenshots: 'failure',      // all | failure | none
  headless: true,
  browser: { executablePath: null, args: ['--no-sandbox'] },
  vars: {},
  headers: {},                 // default headers for api steps
  alwaysRun: { tags: ['smoke'], priorities: [] },
  onUnmapped: 'all',           // all | ignore  (changed files that match no impact rule)
  impact: [],                  // [{ paths: [glob], tags: [tag] }]
  draftsDir: 'drafts',         // AI-generated cases wait here until a human runs "regtest approve"
  ai: {                        // Claude CLI in headless mode; uses your "claude login", no API key
    provider: 'claude-cli', command: 'claude', model: 'sonnet',
    models: { gen: 'sonnet', explain: 'haiku' },   // cheaper model for small tasks
    maxCalls: 5, timeoutMs: 180000,
  },
};

function loadConfig(projectDir) {
  const root = path.resolve(projectDir || process.cwd());
  const file = ['regtest.config.yaml', 'regtest.config.yml', 'regtest.config.json']
    .map((f) => path.join(root, f)).find(fs.existsSync);
  if (!file) throw new Error(`No regtest.config.yaml in ${root} (run "regtest init")`);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  const cfg = { ...DEFAULTS, ...raw,
    browser: { ...DEFAULTS.browser, ...(raw.browser || {}) },
    alwaysRun: { ...DEFAULTS.alwaysRun, ...(raw.alwaysRun || {}) },
    ai: { ...DEFAULTS.ai, ...(raw.ai || {}), models: { ...DEFAULTS.ai.models, ...((raw.ai || {}).models || {}) } } };
  cfg.root = root;
  if (process.env.REGTEST_CLAUDE) cfg.ai.command = process.env.REGTEST_CLAUDE;
  cfg.apiBaseUrl = cfg.apiBaseUrl || cfg.baseUrl;
  cfg.browser.executablePath = process.env.REGTEST_CHROMIUM || cfg.browser.executablePath || undefined;
  // env overrides so CI can point the same suite at any environment
  if (process.env.REGTEST_BASE_URL) cfg.baseUrl = process.env.REGTEST_BASE_URL;
  if (process.env.REGTEST_API_URL) cfg.apiBaseUrl = process.env.REGTEST_API_URL;
  return cfg;
}
module.exports = { loadConfig, DEFAULTS };
