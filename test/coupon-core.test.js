'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../fortune/coupon-core');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('parseAmount accepts shop-style input', () => {
  assert.strictEqual(c.parseAmount('850'), 850);
  assert.strictEqual(c.parseAmount('1,250'), 1250);
  assert.strictEqual(c.parseAmount('฿350'), 350);
  assert.strictEqual(c.parseAmount('850 บาท'), 850);
  assert.strictEqual(c.parseAmount('99.5'), 99.5);
  assert.strictEqual(c.parseAmount(1000), 1000);
});
t('parseAmount rejects junk, zero, negative, huge', () => {
  for (const bad of ['', '0', '-5', 'abc', '12abc', '1.234', '99999999', null, undefined, NaN, -1, 0, Infinity]) {
    assert.strictEqual(c.parseAmount(bad), null, 'should reject ' + String(bad));
  }
});
t('normalizeTiers sorts, dedupes, drops invalid; non-array → defaults', () => {
  assert.deepStrictEqual(c.normalizeTiers([{ min: 1000, percent: 10 }, { min: 500, percent: 5 }, { min: 500, percent: 7 }, { min: -1, percent: 5 }, { min: 300, percent: 0 }, { min: 300, percent: 101 }, null, { min: 'x', percent: 5 }]),
    [{ min: 500, percent: 7 }, { min: 1000, percent: 10 }]);
  assert.deepStrictEqual(c.normalizeTiers('x'), c.DEFAULT_TIERS);
  assert.deepStrictEqual(c.normalizeTiers([]), []);
});
t('pickTier boundaries', () => {
  const tiers = [{ min: 500, percent: 5 }, { min: 1000, percent: 10 }];
  assert.strictEqual(c.pickTier(tiers, 499.99), null);
  assert.strictEqual(c.pickTier(tiers, 500).percent, 5);
  assert.strictEqual(c.pickTier(tiers, 999).percent, 5);
  assert.strictEqual(c.pickTier(tiers, 1000).percent, 10);
  assert.strictEqual(c.pickTier(tiers, 99999).percent, 10);
  assert.strictEqual(c.pickTier(tiers, 'abc'), null);
  assert.strictEqual(c.pickTier([], 5000), null);
});
t('genCode: prefix, 6 unambiguous chars, unique vs taken', () => {
  const code = c.genCode('sh', (k) => 0, null);
  assert.strictEqual(code, 'SHAAAAAA');
  assert.ok(!/[01OI]/.test(c.genCode('SH', (k) => Math.floor(Math.random() * k), null).slice(2)));
  const taken = new Set(['SHAAAAAA']);
  let calls = 0;
  const code2 = c.genCode('SH', (k) => (calls++ < 6 ? 0 : 1), taken);
  assert.notStrictEqual(code2, 'SHAAAAAA');
  assert.throws(() => c.genCode('SH', () => 0, new Set(['SHAAAAAA'])), /unique/);
  assert.strictEqual(c.sanitizePrefix('s-h!วว12345'), 'SH12');
});
t('displayCode / normalizeCode', () => {
  assert.strictEqual(c.displayCode('SHABC234'), 'SH-ABC234');
  assert.strictEqual(c.normalizeCode(' sh-abc234 '), 'SHABC234');
});
t('thaiDate uses Buddhist year, dd/mm', () => {
  assert.strictEqual(c.thaiDate(new Date(2026, 10, 18, 12).getTime()), '18/11/2569');
});
t('pending: single use, expires, invalid rejected', () => {
  let now = 1000;
  const p = c.createPending({ now: () => now, ttlMs: 600000 });
  assert.strictEqual(p.peek(), null);
  assert.strictEqual(p.set('abc'), false);
  assert.strictEqual(p.set('850'), true);
  assert.strictEqual(p.peek(), 850);
  assert.strictEqual(p.take(), 850);
  assert.strictEqual(p.take(), null);
  p.set('900'); now += 600001;
  assert.strictEqual(p.peek(), null);
  assert.strictEqual(p.take(), null);
  p.set('900'); p.clear();
  assert.strictEqual(p.peek(), null);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-'));
const file = path.join(tmp, 'ร้าน ทดสอบ', 'x.json'); // path มีช่องว่าง/ภาษาไทย
fs.mkdirSync(path.dirname(file));

t('store: mint does not persist; commit does; check/markUsed lifecycle', () => {
  let now = new Date(2026, 10, 18, 10).getTime();
  const s = c.createCouponStore({ file, now: () => now });
  const rec = s.mint({ amount: 1200, percent: 10, prefix: 'SH', validDays: 30 });
  assert.strictEqual(s.check(rec.code).status, 'notfound');
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(s.commit(rec), true);
  assert.strictEqual(s.check(rec.code).status, 'valid');
  assert.strictEqual(s.check(c.displayCode(rec.code).toLowerCase()).status, 'valid', 'accepts typed/dashed/lowercase');
  assert.strictEqual(c.thaiDate(rec.expiresAt), '18/12/2569');
  const r1 = s.markUsed(rec.code);
  assert.strictEqual(r1.status, 'marked');
  assert.strictEqual(s.markUsed(rec.code).status, 'used');
  assert.strictEqual(s.check(rec.code).status, 'used');
  // persisted across reload
  const s2 = c.createCouponStore({ file, now: () => now });
  assert.strictEqual(s2.check(rec.code).status, 'used');
});
t('store: expiry is end of the last day, then expired; cannot use expired', () => {
  let now = new Date(2026, 10, 18, 10).getTime();
  const f = path.join(tmp, 'b.json');
  const s = c.createCouponStore({ file: f, now: () => now });
  const rec = s.mint({ amount: 600, percent: 5, prefix: 'SH', validDays: 1 });
  s.commit(rec);
  now = new Date(2026, 10, 19, 23, 59).getTime();
  assert.strictEqual(s.check(rec.code).status, 'valid');
  now = new Date(2026, 10, 20, 0, 1).getTime();
  assert.strictEqual(s.check(rec.code).status, 'expired');
  assert.strictEqual(s.markUsed(rec.code).status, 'expired');
});
t('store: validDays clamped; corrupt/missing file tolerated; unwritable path does not throw', () => {
  const f = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(f, '{"not":"array"');
  const s = c.createCouponStore({ file: f });
  assert.deepStrictEqual(s.recent(), []);
  const rec = s.mint({ amount: 600, percent: 5, prefix: 'SH', validDays: 99999 });
  assert.ok(rec.expiresAt - rec.issuedAt <= 366 * 24 * 3600 * 1000);
  const bad = c.createCouponStore({ file: path.join(tmp, 'nodir', 'x.json') });
  assert.strictEqual(bad.commit(bad.mint({ amount: 600, percent: 5, prefix: 'SH', validDays: 5 })), false);
  assert.strictEqual(bad.check('zzz').status, 'notfound');
});
t('store: 200 mints are unique', () => {
  const s = c.createCouponStore({ file: path.join(tmp, 'u.json') });
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const r = s.mint({ amount: 600, percent: 5, prefix: 'SH', validDays: 30 }); assert.ok(!seen.has(r.code)); seen.add(r.code); s.commit(r); }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
