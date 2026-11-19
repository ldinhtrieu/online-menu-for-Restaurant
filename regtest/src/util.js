'use strict';
const fs = require('fs');
const path = require('path');

/** Convert a glob (supports **, *, ?) into a RegExp matching POSIX-style relative paths. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const matchesAny = (file, globs) => (globs || []).some((g) => globToRegExp(g).test(file));

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out.sort();
}

/** ${var} / ${env.X} interpolation, deep over objects/arrays. */
function interpolate(value, vars) {
  if (typeof value === 'string') {
    const only = value.match(/^\$\{([^}]+)\}$/);
    const get = (k) => {
      const v = k.startsWith('env.') ? process.env[k.slice(4)] : getPath(vars, k);
      if (v === undefined) throw new Error(`Undefined variable \${${k}}`);
      return v;
    };
    if (only) return get(only[1]);               // keep original type
    return value.replace(/\$\{([^}]+)\}/g, (_, k) => String(get(k)));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  return value;
}

/** Read "a.b[0].c" from an object. */
function getPath(obj, p) {
  const parts = String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { globToRegExp, matchesAny, walk, interpolate, getPath, slug, esc };
