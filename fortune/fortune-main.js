// เซียมซีต่อท้ายใบเสร็จ — โมดูลแยกจาก main.js
// ไดรเวอร์ TM-T82III ตั้ง Paper Cut = No Cut → ที่นี่เฝ้าคิวเครื่องพิมพ์ เมื่อใบเสร็จพิมพ์จบจึงพิมพ์เซียมซีต่อ
// แล้วส่งคำสั่งตัดเอง ทุกจุดครอบ try/catch และ "ใบเสร็จต้องถูกตัดเสมอ" ถ้าเซียมซีพลาดจะส่งแค่คำสั่งตัด
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
let coupon = null; // คูปองพังต้องไม่ทำให้เซียมซี/การตัดกระดาษพัง — โหลดไม่ได้ = ไม่มีคูปอง
try { coupon = require('./coupon-core'); } catch (e) { console.error('coupon-core failed to load:', e); }

const SLIP_WIDTH = 576;
const OWN_JOB = /pos hero receipt/i;       // งานที่ POS Hero ส่งเอง (ตัดกระดาษในตัวอยู่แล้ว)
const HB_STALE_MS = 30 * 1000;
const SEEN_LIMIT = 200;
const ESC_FEED_CUT = Buffer.from([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]); // ESC d 2 + GS V 65 0
const ESC_INIT = Buffer.from([0x1b, 0x40]);

const DEFAULTS = {
  enabled: false,        // เปิดโหมด "โปรแกรมตัดกระดาษเอง" (ไดรเวอร์ต้องตั้ง No Cut) — ปิด = ไม่เฝ้าคิว ไม่ส่งอะไรเลย
  recordOnly: false,     // ขั้น 0: บันทึกงานพิมพ์ลง print-jobs.log อย่างเดียว ไม่พิมพ์/ไม่ตัด
  slipEnabled: true,     // พิมพ์เซียมซี (ปิด = ตัดกระดาษอย่างเดียว)
  includeLow: true,
  showChinese: true,     // พิมพ์กลอนจีน
  showThaiPoem: true,    // พิมพ์คำแปลกลอนเป็นไทย (ปิดทั้งสองอัน = พิมพ์แค่สรุปความหมาย)      // รวมใบ 下签 ครบ 100 ใบ (ปิด = สุ่มจาก 83 ใบ)
  printerName: '',       // ว่าง = เครื่องพิมพ์ default ของ Windows
  docFilter: 'Sea & Hill', // ชื่อเอกสารที่มีข้อความนี้ = ใบเสร็จที่ได้เซียมซี (ไม่สนตัวพิมพ์เล็กใหญ่)
  startDate: '',         // YYYY-MM-DD ว่าง = ไม่จำกัด
  endDate: '',
  footer: 'สวัสดีปีใหม่ 2570 · อึ้งลักเส็ง 黄六盛',
  couponEnabled: false,  // คูปองส่วนลดตามยอดต่อท้ายเซียมซี (ต้องกรอกยอดบิลที่หน้าต่าง "ยอดบิล") — ปิดเป็นค่าเริ่มต้น
  couponTiers: [{ min: 500, percent: 5 }, { min: 1000, percent: 10 }], // [{min: ยอดขั้นต่ำ, percent: ส่วนลด%}] ตัวอย่างตั้งต้น แก้ในหน้าตั้งค่า
  couponValidDays: 30,   // อายุคูปอง (วัน) นับจากวันที่ออก หมดอายุสิ้นวัน
  couponPrefix: 'SH'     // ตัวอักษรนำหน้ารหัส (A-Z/0-9 สูงสุด 4 ตัว)
};

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function create({ app, BrowserWindow, ipcMain, Notification, buildEscPosRaster, sendRaw, getDefaultPrinterName, onStatsChange }) {
  const userData = app.getPath('userData');
  const settingsPath = path.join(userData, 'fortune-settings.json');
  const statsPath = path.join(userData, 'fortune-stats.json');
  const logPath = path.join(userData, 'print-jobs.log');
  const unpacked = (rel) => app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', rel)
    : path.join(__dirname, '..', rel);

  let settings = { ...DEFAULTS };
  let stats = { date: localDate(), count: 0 };
  let fortunes = [];
  const slipCache = new Map();  // index → Buffer (ESC/POS ไม่มี ESC @ และปิดท้ายด้วยคำสั่งตัด)
  let renderWin = null;
  let renderChain = Promise.resolve();
  let watcher = null;
  let lastBeat = 0;
  let stopped = true;
  let restartTimer = null;
  let staleTimer = null;
  let staleNotified = false;
  const seen = [];
  let sendChain = Promise.resolve();
  let settingsWin = null;
  let amountWin = null;
  const pending = coupon ? coupon.createPending() : null;   // ยอดบิลที่แคชเชียร์กรอกรอบิลถัดไป
  let couponStore = null;
  try { if (coupon) couponStore = coupon.createCouponStore({ file: path.join(userData, 'fortune-coupons.json') }); } catch (e) { couponStore = null; }

  function log(msg) {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* ignore */ }
  }
  function loadJson(file, fallback) {
    try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }; } catch (e) { return { ...fallback }; }
  }
  function saveJson(file, obj) {
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { log('save failed ' + e.message); }
  }
  function loadFortunes() {
    try { fortunes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fortunes.json'), 'utf-8')); } catch (e) { fortunes = []; log('fortunes.json: ' + e.message); }
  }
  function notify(title, body) {
    try { new Notification({ title, body }).show(); } catch (e) { /* ignore */ }
  }

  // ---------- สถิติ ----------
  function todayCount() {
    if (stats.date !== localDate()) { stats = { date: localDate(), count: 0 }; saveJson(statsPath, stats); }
    return stats.count;
  }
  function bumpCount() {
    todayCount(); stats.count++; saveJson(statsPath, stats);
    try { if (onStatsChange) onStatsChange(); } catch (e) { /* ignore */ }
  }

  // ---------- เรนเดอร์ใบเซียมซี ----------
  function allowedIndexes() {
    const out = [];
    fortunes.forEach((f, i) => { if (settings.includeLow || f[0] !== '下') out.push(i); });
    return out;
  }

  async function ensureRenderWin() {
    if (renderWin && !renderWin.isDestroyed()) return renderWin;
    renderWin = new BrowserWindow({
      show: false, width: SLIP_WIDTH, height: 900, useContentSize: true, frame: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false }
    });
    await renderWin.loadFile(path.join(__dirname, 'slip.html'));
    return renderWin;
  }

  function renderSlip(index) {
    const job = renderChain.then(async () => {
      if (slipCache.has(index)) return slipCache.get(index);
      const win = await ensureRenderWin();
      const wc = win.webContents;
      const h = await wc.executeJavaScript(`render(${JSON.stringify(fortunes[index])}, ${index + 1}, ${JSON.stringify(settings.footer)}, ${JSON.stringify({ zh: settings.showChinese, th: settings.showThaiPoem })})`);
      const height = Math.max(40, Math.ceil(h) + 2);
      win.setContentSize(SLIP_WIDTH, height);
      await new Promise((r) => setTimeout(r, 30)); // ให้เลย์เอาต์ใหม่เสร็จก่อนจับภาพ
      const img = await wc.capturePage({ x: 0, y: 0, width: SLIP_WIDTH, height });
      const sized = img.getSize().width === SLIP_WIDTH ? img : img.resize({ width: SLIP_WIDTH, quality: 'best' });
      const s = sized.getSize();
      const buf = buildEscPosRaster(sized.toBitmap(), s.width, s.height, { init: false }); // ปิดท้ายด้วย ESC d 2 + GS V 65 0
      slipCache.set(index, buf);
      return buf;
    });
    renderChain = job.catch(() => {}); // ห่วงโซ่ต้องไม่พังเพราะงานเดียว
    return job;
  }

  // ---------- คูปองส่วนลด ----------
  // เรนเดอร์ใบคูปองต่อใบ (ไม่เข้า slipCache เพราะมีรหัสไม่ซ้ำกัน) ปิดท้ายด้วย ESC d 2 + GS V 65 0 เหมือนใบเซียมซี
  function renderCoupon(c) {
    const job = renderChain.then(async () => {
      const win = await ensureRenderWin();
      const wc = win.webContents;
      const h = await wc.executeJavaScript(`renderCoupon(${JSON.stringify(c)})`);
      const height = Math.max(40, Math.ceil(h) + 2);
      win.setContentSize(SLIP_WIDTH, height);
      await new Promise((r) => setTimeout(r, 30));
      const img = await wc.capturePage({ x: 0, y: 0, width: SLIP_WIDTH, height });
      const sized = img.getSize().width === SLIP_WIDTH ? img : img.resize({ width: SLIP_WIDTH, quality: 'best' });
      const s = sized.getSize();
      return buildEscPosRaster(sized.toBitmap(), s.width, s.height, { init: false });
    });
    renderChain = job.catch(() => {});
    return job;
  }

  // ใช้ยอดค้าง (ครั้งเดียว) → เลือกขั้น → สร้างรหัส + เรนเดอร์; ไม่ออกคูปอง = null (ไม่ throw ออกไปนอกฟังก์ชันนี้ถ้าเรียกผ่าน try)
  async function buildCoupon() {
    if (!coupon || !couponStore || !pending || !settings.couponEnabled) return null;
    const amount = pending.take();
    if (amount == null) { log('coupon: no pending amount, plain slip'); return null; }
    const tier = coupon.pickTier(settings.couponTiers, amount);
    if (!tier) { log('coupon: amount below first tier, plain slip'); return null; }
    const record = couponStore.mint({ amount, percent: tier.percent, prefix: settings.couponPrefix, validDays: settings.couponValidDays });
    const buf = await renderCoupon({ percent: record.percent, code: coupon.displayCode(record.code), expires: coupon.thaiDate(record.expiresAt) });
    return { record, buf };
  }

  async function prerenderAll() {
    for (const i of allowedIndexes()) {
      try { await renderSlip(i); } catch (e) { log('prerender ' + i + ': ' + e.message); }
      await new Promise((r) => setTimeout(r, 20));
    }
    log('prerender done: ' + slipCache.size);
    if (renderWin && !renderWin.isDestroyed()) { renderWin.destroy(); renderWin = null; }
  }

  function pickIndex() {
    const pool = allowedIndexes();
    if (!pool.length) return -1;
    return pool[crypto.randomInt(pool.length)];
  }

  // ---------- ส่งเข้าเครื่องพิมพ์ ----------
  async function printerName() {
    if (settings.printerName) return settings.printerName;
    return await getDefaultPrinterName();
  }

  function enqueueSend(fn) {
    const p = sendChain.then(fn);
    sendChain = p.catch(() => {});
    return p;
  }

  function inDateRange() {
    const today = localDate();
    if (settings.startDate && today < settings.startDate) return false;
    if (settings.endDate && today > settings.endDate) return false;
    return true;
  }

  function wantsSlip(doc) {
    if (!settings.slipEnabled || !inDateRange()) return false;
    const f = (settings.docFilter || '').trim().toLowerCase();
    return !!f && String(doc || '').toLowerCase().includes(f);
  }

  async function handleDone(ev) {
    if (seen.includes(ev.id)) return;
    seen.push(ev.id); if (seen.length > SEEN_LIMIT) seen.shift();
    if (OWN_JOB.test(ev.doc || '')) return;
    if (settings.recordOnly || !settings.enabled) return;

    await enqueueSend(async () => {
      const name = await printerName();
      if (wantsSlip(ev.doc)) {
        try {
          const idx = pickIndex();
          if (idx < 0) throw new Error('no fortunes');
          const slip = await renderSlip(idx);
          let out = slip, minted = null;
          try {
            // คูปองต่อท้ายเซียมซี: ตัดคำสั่งตัดท้ายใบเซียมซีออก แล้วให้ใบคูปองเป็นตัวปิดท้าย+ตัด
            // พลาดตรงไหน = พิมพ์เซียมซีเดิม (มีคำสั่งตัดอยู่แล้ว) ใบเสร็จต้องถูกตัดเสมอ
            if (slip.length > ESC_FEED_CUT.length && slip.subarray(slip.length - ESC_FEED_CUT.length).equals(ESC_FEED_CUT)) {
              minted = await buildCoupon();
              if (minted) out = Buffer.concat([slip.subarray(0, slip.length - ESC_FEED_CUT.length), minted.buf]);
            }
          } catch (e) { log('coupon skipped: ' + e.message); minted = null; out = slip; }
          const r = await sendRaw(out, name);
          if (!r.success) throw new Error(r.reason);
          bumpCount();
          log(`slip #${idx + 1} after job ${ev.id} "${ev.doc}"`);
          if (minted) {
            const saved = couponStore.commit(minted.record);
            log(`coupon ${minted.record.percent}% issued ${coupon.displayCode(minted.record.code)}${saved ? '' : ' (SAVE FAILED)'}`);
            if (!saved) notify('บันทึกคูปองไม่สำเร็จ', 'คูปองถูกพิมพ์แล้วแต่ตรวจรหัสในเครื่องนี้ไม่ได้ — จดรหัส ' + coupon.displayCode(minted.record.code));
          }
          return;
        } catch (e) {
          log('slip failed, falling back to cut only: ' + e.message);
        }
      }
      const r = await sendRaw(ESC_FEED_CUT, name);
      if (!r.success) {
        log('CUT FAILED: ' + r.reason);
        notify('ตัดกระดาษไม่สำเร็จ', r.reason);
      }
    });
  }

  // ---------- watcher ----------
  async function startWatcher() {
    if (watcher || stopped) return;
    let name;
    try { name = await printerName(); } catch (e) { log('printer name: ' + e.message); }
    if (!name) { log('no printer to watch'); scheduleRestart(); return; }
    if (watcher || stopped) return;
    const script = unpacked(path.join('fortune', 'job-watcher.ps1'));
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', name], { windowsHide: true });
    watcher = child;
    lastBeat = Date.now();
    log('watcher started for "' + name + '"');
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
        lastBeat = Date.now();
        staleNotified = false;
        if (ev.ev === 'hb') continue;
        if (ev.ev === 'error') { log('watcher error: ' + ev.msg); continue; }
        log(`job ${ev.ev} id=${ev.id} doc="${ev.doc}" status=${ev.status || ''}`);
        if (ev.ev === 'done') handleDone(ev).catch((e) => log('handleDone: ' + e.message));
      }
    });
    child.stderr.on('data', (d) => log('watcher stderr: ' + String(d).trim()));
    child.on('exit', (code) => {
      log('watcher exited ' + code);
      if (watcher === child) watcher = null;
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; startWatcher(); }, 2000);
  }

  function stopWatcher() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (watcher) { const w = watcher; watcher = null; try { w.kill(); } catch (e) { /* ignore */ } }
  }

  function applyMode() {
    const shouldRun = settings.enabled || settings.recordOnly;
    stopWatcher();
    stopped = !shouldRun;
    if (shouldRun) startWatcher();
  }

  function startStaleCheck() {
    if (staleTimer) return;
    staleTimer = setInterval(() => {
      if (stopped || !watcher) return;
      if (Date.now() - lastBeat > HB_STALE_MS) {
        log('watcher stale, restarting');
        if (!staleNotified) {
          staleNotified = true;
          notify('POS Hero: ตัวเฝ้าคิวพิมพ์หยุดทำงาน', 'กำลังรีสตาร์ท — ถ้าใบเสร็จไม่ถูกตัด ให้ตั้งไดรเวอร์ Paper Cut = Cut ชั่วคราว');
        }
        stopWatcher();
        setTimeout(() => { if (!stopped) startWatcher(); }, 500);
      }
    }, 10000);
  }

  // ---------- หน้าตั้งค่า / IPC ----------
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({
      width: 480, height: 840, title: 'ตั้งค่าเซียมซี', autoHideMenuBar: true, minimizable: false,
      webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    settingsWin.setMenu(null);
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  // หน้าต่างเล็กลอยค้างสำหรับกรอกยอดบิล (แคชเชียร์พิมพ์ยอด → Enter → ใช้กับใบเสร็จถัดไปครั้งเดียว)
  function openAmount() {
    if (amountWin && !amountWin.isDestroyed()) { amountWin.show(); amountWin.focus(); return; }
    amountWin = new BrowserWindow({
      width: 320, height: 250, title: 'ยอดบิล (คูปอง)', autoHideMenuBar: true, minimizable: false, maximizable: false, resizable: false,
      alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'amount-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    amountWin.setMenu(null);
    amountWin.setAlwaysOnTop(true, 'floating');
    try {
      const { screen } = require('electron');
      const wa = screen.getPrimaryDisplay().workArea;
      amountWin.setPosition(wa.x + wa.width - 340, wa.y + wa.height - 270);
    } catch (e) { /* ใช้ตำแหน่งตั้งต้น */ }
    amountWin.loadFile(path.join(__dirname, 'amount.html'));
    amountWin.on('closed', () => { amountWin = null; });
  }

  function amountInfo() {
    const amount = pending ? pending.peek() : null;
    const tier = amount != null && coupon ? coupon.pickTier(settings.couponTiers, amount) : null;
    return {
      couponEnabled: !!settings.couponEnabled && !!coupon && !!couponStore,
      amount, remainingMs: pending ? pending.remainingMs() : 0,
      percent: tier ? tier.percent : null,
      tiers: coupon ? coupon.normalizeTiers(settings.couponTiers) : []
    };
  }

  function registerCouponIpc() {
    ipcMain.handle('fortune:amount-get', () => { try { return amountInfo(); } catch (e) { return { couponEnabled: false, amount: null, remainingMs: 0, percent: null, tiers: [] }; } });
    ipcMain.handle('fortune:amount-set', (_e, raw) => {
      try {
        if (!pending || !pending.set(raw)) return { ok: false, reason: 'ใส่ยอดเป็นตัวเลข เช่น 850 หรือ 1,250' };
        return { ok: true, info: amountInfo() };
      } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('fortune:amount-clear', () => { try { if (pending) pending.clear(); } catch (e) { /* ignore */ } return { ok: true }; });
    ipcMain.handle('fortune:coupon-check', (_e, code) => {
      try { return couponStore ? { ok: true, ...couponStore.check(code) } : { ok: false, reason: 'ระบบคูปองไม่พร้อมใช้งาน' }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('fortune:coupon-use', (_e, code) => {
      try { return couponStore ? { ok: true, ...couponStore.markUsed(code) } : { ok: false, reason: 'ระบบคูปองไม่พร้อมใช้งาน' }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('fortune:coupon-recent', () => { try { return couponStore ? couponStore.recent(15) : []; } catch (e) { return []; } });
  }

  function registerIpc() {
    try { registerCouponIpc(); } catch (e) { log('coupon ipc: ' + e.message); }
    ipcMain.handle('fortune:get', () => ({ settings, today: todayCount(), total: fortunes.length, cached: slipCache.size }));
    ipcMain.handle('fortune:set', (_e, patch) => {
      const prevLow = settings.includeLow, prevFooter = settings.footer, prevLook = `${settings.showChinese}${settings.showThaiPoem}`;
      const next = { ...settings };
      for (const k of Object.keys(DEFAULTS)) {
        if (patch && k in patch && typeof patch[k] === typeof DEFAULTS[k]) next[k] = patch[k];
      }
      if (coupon) {
        // ค่าคูปองที่ไม่ใช่ชนิดง่ายๆ ต้องตรวจเอง (ขั้น = array, วัน = จำนวนเต็ม 1–365, prefix = A-Z/0-9)
        next.couponTiers = coupon.normalizeTiers(patch && 'couponTiers' in patch ? patch.couponTiers : settings.couponTiers);
        next.couponValidDays = Math.min(365, Math.max(1, Math.floor(Number(next.couponValidDays)) || 30));
        next.couponPrefix = coupon.sanitizePrefix(next.couponPrefix);
      }
      settings = next;
      saveJson(settingsPath, settings);
      if (settings.footer !== prevFooter || `${settings.showChinese}${settings.showThaiPoem}` !== prevLook) { slipCache.clear(); if (settings.enabled && settings.slipEnabled) setTimeout(() => prerenderAll().catch(() => {}), 500); }
      if (settings.includeLow && !prevLow) prerenderAll().catch(() => {});
      applyMode();
      try { if (onStatsChange) onStatsChange(); } catch (e) { /* ignore */ }
      return { ok: true };
    });
    ipcMain.handle('fortune:test', async () => {
      try {
        const idx = pickIndex();
        if (idx < 0) return { success: false, reason: 'ไม่มีข้อมูลเซียมซี' };
        const slip = await renderSlip(idx);
        return await enqueueSend(async () => sendRaw(Buffer.concat([ESC_INIT, slip]), await printerName()));
      } catch (e) { return { success: false, reason: e.message }; }
    });
    ipcMain.handle('fortune:printers', async () => {
      try { return (await BrowserWindow.getAllWindows()[0].webContents.getPrintersAsync()).map((p) => p.name); } catch (e) { return []; }
    });
  }

  function start() {
    settings = loadJson(settingsPath, DEFAULTS);
    stats = loadJson(statsPath, stats);
    loadFortunes();
    registerIpc();
    startStaleCheck();
    applyMode();
    // เรนเดอร์ล่วงหน้าหลังเปิดแอปสักพัก เพื่อให้พิมพ์จริงไม่มีความหน่วง
    if (settings.enabled && settings.slipEnabled) setTimeout(() => prerenderAll().catch(() => {}), 8000);
  }

  return { start, openSettings, openAmount, todayCount, _handleDone: handleDone, _pending: pending, _store: couponStore }; // _ = สำหรับ test เท่านั้น
}

module.exports = { create, DEFAULTS };
