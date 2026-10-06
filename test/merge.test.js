// node test/merge.test.js
const assert = require('node:assert');
const { compareItems, mergeItem, isTooFarInFuture, normalizeCategories, FUTURE_LIMIT_MS } = require('../catalog/shared/merge');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); } };
const it = (updatedAt, updatedBy, extra) => ({ id: 'a', updatedAt, updatedBy, ...extra });

t('newer updatedAt wins either way round', () => {
  const a = it(100, 'dev-a', { name: 'เก่า' }), b = it(200, 'dev-b', { name: 'ใหม่' });
  assert.strictEqual(mergeItem(a, b), b);
  assert.strictEqual(mergeItem(b, a), b);
});
t('equal updatedAt: larger updatedBy wins, order independent', () => {
  const a = it(100, 'dev-a', { name: 'A' }), b = it(100, 'dev-b', { name: 'B' });
  assert.strictEqual(mergeItem(a, b).name, 'B');
  assert.strictEqual(mergeItem(b, a).name, 'B');
});
t('identical stamp compares equal and keeps local', () => {
  const a = it(100, 'dev-a', { name: 'local' }), b = it(100, 'dev-a', { name: 'remote' });
  assert.strictEqual(compareItems(a, b), 0);
  assert.strictEqual(mergeItem(a, b), a);
});
t('missing side always loses', () => {
  const a = it(1, 'x');
  assert.strictEqual(mergeItem(null, a), a);
  assert.strictEqual(mergeItem(a, null), a);
  assert.strictEqual(compareItems(null, null), 0);
});
t('tombstone newer than edit deletes, and stays deleted against an older edit', () => {
  const edit = it(100, 'dev-a', { name: 'x' }), del = it(200, 'dev-b', { deleted: true });
  assert.strictEqual(mergeItem(edit, del).deleted, true);
  assert.strictEqual(mergeItem(del, edit).deleted, true);
});
t('edit newer than tombstone revives', () => {
  const del = it(100, 'dev-a', { deleted: true }), edit = it(200, 'dev-b', { name: 'กลับมา' });
  assert.strictEqual(mergeItem(del, edit).name, 'กลับมา');
});
t('merge is commutative and idempotent over many random pairs', () => {
  const devs = ['d1', 'd2', 'd3'];
  for (let i = 0; i < 500; i++) {
    const a = it(Math.floor(Math.random() * 5), devs[i % 3], { n: 'a' + i });
    const b = it(Math.floor(Math.random() * 5), devs[(i + 1) % 3], { n: 'b' + i });
    if (compareItems(a, b) === 0) continue;
    assert.strictEqual(mergeItem(a, b), mergeItem(b, a));
    assert.strictEqual(mergeItem(mergeItem(a, b), b), mergeItem(a, b));
  }
});
t('clock skew: future beyond 10 minutes is rejected, inside is fine', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(isTooFarInFuture(now + FUTURE_LIMIT_MS + 1, now), true);
  assert.strictEqual(isTooFarInFuture(now + FUTURE_LIMIT_MS, now), false);
  assert.strictEqual(isTooFarInFuture(now - 86400000, now), false);
});
t('normalizeCategories keeps order, dedupes, always has ทั่วไป', () => {
  assert.deepStrictEqual(normalizeCategories(['ขนม', ' ขนม ', '', 'น้ำ']), ['ทั่วไป', 'ขนม', 'น้ำ']);
  assert.deepStrictEqual(normalizeCategories(['น้ำ', 'ทั่วไป']), ['น้ำ', 'ทั่วไป']);
  assert.deepStrictEqual(normalizeCategories(undefined), ['ทั่วไป']);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
