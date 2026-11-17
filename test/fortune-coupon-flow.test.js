'use strict';
// ทดสอบเส้นทางพิมพ์จริง (handleDone) ด้วยของปลอม: ไม่โหลด electron ไม่แตะเครื่องพิมพ์
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../fortune/fortune-main');

const CUT = Buffer.from([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]);
const countCuts = (b) => { let n = 0, i = -1; while ((i = b.indexOf(CUT, i + 1)) !== -1) n++; return n; };

function setup(settings, { failCoupon = false, failFirstSend = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
  fs.writeFileSync(path.join(dir, 'fortune-settings.json'), JSON.stringify(settings));
  const sent = [];
  let sendCalls = 0;
  class Win {
    constructor() { this.webContents = {
      executeJavaScript: async (code) => { if (code.startsWith('renderCoupon')) { if (failCoupon) throw new Error('boom'); Win.last = 'coupon'; } else Win.last = 'slip'; return 100; },
      capturePage: async () => ({ getSize: () => ({ width: 576, height: 102 }), toBitmap: () => Buffer.alloc(4), resize() { return this; } })
    }; }
    loadFile() { return Promise.resolve(); } setContentSize() {} isDestroyed() { return false; } destroy() {} setMenu() {} on() {}
  }
  const ipc = { handle() {}, on() {} };
  const f = create({
    app: { getPath: () => dir, isPackaged: false }, BrowserWindow: Win, ipcMain: ipc,
    Notification: class { show() {} },
    // ตัวแทน buildEscPosRaster: ภาพ "SLIP"/"CPN" + คำสั่งตัดท้าย เหมือนของจริง (init:false)
    buildEscPosRaster: (bmp, w, h) => Buffer.concat([Buffer.from(Win.last === 'coupon' ? 'CPN' : 'SLP'), CUT]),
    sendRaw: async (buf) => { sendCalls++; sent.push(buf); return (failFirstSend && sendCalls === 1) ? { success: false, reason: 'usb' } : { success: true }; },
    getDefaultPrinterName: async () => ''
  });
  return { f, sent, dir };
}
const base = { enabled: true, slipEnabled: true, docFilter: 'Sea & Hill', couponEnabled: true, couponTiers: [{ min: 500, percent: 5 }, { min: 1000, percent: 10 }], couponValidDays: 30, couponPrefix: 'SH' };
let n = 0;
const run = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };
let jobId = 100;
const done = (f, doc = 'Sea & Hill #1') => f._handleDone({ id: ++jobId, doc });

(async () => {
  await run('no pending amount → plain slip, exactly one cut at end', async () => {
    const { f, sent } = setup(base); f.start();
    await done(f);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1);
    assert.ok(sent[0].indexOf('CPN') === -1, 'no coupon without amount');
    assert.ok(sent[0].subarray(sent[0].length - CUT.length).equals(CUT));
  });
  await run('pending 1200 → slip + coupon, ONE cut at the very end, coupon saved, pending consumed', async () => {
    const { f, sent } = setup(base); f.start();
    f._pending.set('1200');
    await done(f);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1, 'cut only once, at the end');
    assert.ok(sent[0].subarray(sent[0].length - CUT.length).equals(CUT));
    assert.strictEqual(f._pending.peek(), null);
    const rec = f._store.recent(5);
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].percent, 10);
    assert.strictEqual(rec[0].amount, 1200);
    const iS = sent[0].indexOf('SLP'), iC = sent[0].indexOf('CPN');
    assert.ok(iS >= 0 && iC > iS, 'slip first, then coupon');
    assert.ok(!sent[0].subarray(iS, iC).includes(CUT), 'no cut between slip and coupon');
  });
  await run('pending 600 → 5%; pending 100 → no coupon (plain)', async () => {
    const a = setup(base); a.f.start(); a.f._pending.set('600'); await done(a.f);
    assert.strictEqual(a.f._store.recent(5)[0].percent, 5);
    const b = setup(base); b.f.start(); b.f._pending.set('100'); await done(b.f);
    assert.strictEqual(b.f._store.recent(5).length, 0);
    assert.strictEqual(b.sent.length, 1); assert.strictEqual(countCuts(b.sent[0]), 1);
  });
  await run('coupon render fails → plain slip still printed, nothing saved', async () => {
    const { f, sent } = setup(base, { failCoupon: true }); f.start();
    f._pending.set('1200'); await done(f);
    assert.strictEqual(sent.length, 1); assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(f._store.recent(5).length, 0);
  });
  await run('printing slip+coupon fails → falls back to cut-only, no coupon saved', async () => {
    const { f, sent } = setup(base, { failFirstSend: true }); f.start();
    f._pending.set('1200'); await done(f);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent[1].equals(CUT), 'second send is the cut-only fallback');
    assert.strictEqual(f._store.recent(5).length, 0);
  });
  await run('couponEnabled=false → plain slip and pending is NOT consumed', async () => {
    const { f, sent } = setup({ ...base, couponEnabled: false }); f.start();
    f._pending.set('1200'); await done(f);
    assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(f._pending.peek(), 1200);
  });
  await run('other document → cut only, pending untouched', async () => {
    const { f, sent } = setup(base); f.start();
    f._pending.set('1200'); await done(f, 'Something else');
    assert.ok(sent[0].equals(CUT));
    assert.strictEqual(f._pending.peek(), 1200);
  });
  await run('same job id twice → handled once (no double coupon)', async () => {
    const { f, sent } = setup(base); f.start();
    f._pending.set('1200');
    await f._handleDone({ id: 7, doc: 'Sea & Hill' }); await f._handleDone({ id: 7, doc: 'Sea & Hill' });
    assert.strictEqual(sent.length, 1);
  });
  console.log(`\n${n} flow tests passed`);
  process.exit(0); // watcher/stale timers ของโมดูลยังรันอยู่
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
