'use strict';
// AI layer. Provider: Claude CLI in headless mode (`claude -p`), using the user's logged-in session.
// No API key needed. Every call is tracked so the CLI can print total tokens / cost.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class AI {
  constructor(cfg) {
    this.cfg = cfg;
    this.ai = cfg.ai;
    this.usage = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.cacheFile = path.join(cfg.root, cfg.outDir, 'ai-cache.json');
    this.cache = fs.existsSync(this.cacheFile) ? JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) : {};
  }

  /** task: 'gen' | 'explain' (selects the model). Returns the text answer. */
  async ask(task, prompt, { system, useCache = false } = {}) {
    const model = (this.ai.models || {})[task] || this.ai.model;
    const key = crypto.createHash('sha256').update(JSON.stringify([model, system, prompt])).digest('hex');
    if (useCache && this.cache[key]) { this.usage.cached++; return this.cache[key]; }
    if (this.usage.calls >= this.ai.maxCalls) throw new Error(`AI call limit reached (ai.maxCalls=${this.ai.maxCalls})`);
    this.usage.calls++;
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', model];
    if (system) args.push('--append-system-prompt', system);
    const out = await this._run(args, prompt);
    let j;
    try { j = JSON.parse(out); } catch { throw new Error('Unexpected output from claude CLI: ' + out.slice(0, 300)); }
    if (j.is_error) throw new Error('claude CLI error: ' + (j.result || out.slice(0, 300)));
    const u = j.usage || {};
    this.usage.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    this.usage.outputTokens += u.output_tokens || 0;
    this.usage.costUsd += j.total_cost_usd || 0;
    const text = String(j.result || '').trim();
    if (useCache) {
      this.cache[key] = text;
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    }
    return text;
  }

  _run(args, stdin) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ai.command, args, { cwd: this.cfg.root, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${this.ai.timeoutMs}ms`)); }, this.ai.timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(e.code === 'ENOENT'
          ? `Cannot find "${this.ai.command}". Install Claude Code and run "claude login" (or set ai.command).` : e.message));
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || out) resolve(out); else reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 400)}`));
      });
      p.stdin.end(stdin);
    });
  }

  summary() {
    const u = this.usage;
    return `AI usage: ${u.calls} call(s)${u.cached ? `, ${u.cached} from cache` : ''}, ${u.inputTokens} in / ${u.outputTokens} out tokens, ~$${u.costUsd.toFixed(4)} (list price; on a subscription plan this counts against plan limits instead)`;
  }
}

/** Strip a yaml code fence if the model added one. */
function stripFence(t) {
  const m = String(t).match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i);
  return (m ? m[1] : String(t)).trim();
}

module.exports = { AI, stripFence };
