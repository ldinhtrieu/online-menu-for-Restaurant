'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { globToRegExp, matchesAny, interpolate } = require('../src/util');
const { select } = require('../src/select');
const { matchJson } = require('../src/steps');

test('glob matching', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(matchesAny('menu-be/order.js', ['menu-ui/**', 'menu-be/**']));
});

test('interpolate keeps type for whole-value vars', () => {
  assert.strictEqual(interpolate('${n}', { n: 5 }), 5);
  assert.strictEqual(interpolate('/o/${n}', { n: 5 }), '/o/5');
  assert.throws(() => interpolate('${missing}', {}));
});

const mk = (id, tags, extra = {}) => ({ id, title: id, tags, priority: 'P2', covers: [], skip: false, ...extra });
const cfg = { alwaysRun: { tags: ['smoke'], priorities: [] }, onUnmapped: 'all',
  impact: [{ paths: ['ui/cart/**'], tags: ['cart'] }, { paths: ['docs/**'], tags: [] }] };

test('impact selection: tag mapping + alwaysRun', () => {
  const cases = [mk('A', ['cart']), mk('B', ['order']), mk('S', ['smoke'])];
  const r = select(cases, cfg, { changed: ['ui/cart/x.js'] });
  assert.deepStrictEqual(r.selected.map((s) => s.case.id).sort(), ['A', 'S']);
});
test('unmapped change falls back to all; mapped-to-nothing does not', () => {
  const cases = [mk('A', ['cart']), mk('B', ['order'])];
  assert.strictEqual(select(cases, cfg, { changed: ['other/y.js'] }).selected.length, 2);
  assert.strictEqual(select(cases, cfg, { changed: ['docs/a.md'] }).selected.length, 0);
});
test('covers glob on case selects it directly; skip is honoured', () => {
  const cases = [mk('A', [], { covers: ['api/order*'] }), mk('B', ['cart'], { skip: true })];
  const r = select(cases, { ...cfg, onUnmapped: 'ignore' }, { changed: ['api/orders.js', 'ui/cart/a'] });
  assert.deepStrictEqual(r.selected.map((s) => s.case.id), ['A']);
});

test('matchJson operators', () => {
  matchJson({ a: { b: 1 }, s: 'hello' }, { a: { b: 1 }, s: { $contains: 'ell' }, z: '$absent' });
  assert.throws(() => matchJson({ a: 1 }, { a: 2 }));
  assert.throws(() => matchJson({}, { a: '$exists' }));
});
