// เซียมซีต่อท้ายใบเสร็จ — โมดูลแยกจาก main.js
// ไดรเวอร์ TM-T82III ตั้ง Paper Cut = No Cut → ที่นี่เฝ้าคิวเครื่องพิมพ์ เมื่อใบเสร็จพิมพ์จบจึงพิมพ์เซียมซีต่อ
// แล้วส่งคำสั่งตัดเอง ทุกจุดครอบ try/catch และ "ใบเสร็จต้องถูกตัดเสมอ" ถ้าเซียมซีพลาดจะส่งแค่คำสั่งตัด
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
  includeLow: true,      // รวมใบ 下签 ครบ 100 ใบ (ปิด = สุ่มจาก 83 ใบ)
  printerName: '',       // ว่าง = เครื่องพิมพ์ default ของ Windows
  docFilter: 'Sea & Hill', // ชื่อเอกสารที่มีข้อความนี้ = ใบเสร็จที่ได้เซียมซี (ไม่สนตัวพิมพ์เล็กใหญ่)
  startDate: '',         // YYYY-MM-DD ว่าง = ไม่จำกัด
  endDate: '',
  footer: 'สวัสดีปีใหม่ 2570 · อึ้งลักเส็ง 黄六盛'
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
      const h = await wc.executeJavaScript(`render(${JSON.stringify(fortunes[index])}, ${index + 1}, ${JSON.stringify(settings.footer)})`);
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
          const r = await sendRaw(slip, name);
          if (!r.success) throw new Error(r.reason);
          bumpCount();
          log(`slip #${idx + 1} after job ${ev.id} "${ev.doc}"`);
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
      width: 460, height: 700, title: 'ตั้งค่าเซียมซี', autoHideMenuBar: true, minimizable: false,
      webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    settingsWin.setMenu(null);
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  function registerIpc() {
    ipcMain.handle('fortune:get', () => ({ settings, today: todayCount(), total: fortunes.length, cached: slipCache.size }));
    ipcMain.handle('fortune:set', (_e, patch) => {
      const prevLow = settings.includeLow, prevFooter = settings.footer;
      const next = { ...settings };
      for (const k of Object.keys(DEFAULTS)) {
        if (patch && k in patch && typeof patch[k] === typeof DEFAULTS[k]) next[k] = patch[k];
      }
      settings = next;
      saveJson(settingsPath, settings);
      if (settings.footer !== prevFooter) slipCache.clear();
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

  return { start, openSettings, todayCount };
}

module.exports = { create, DEFAULTS };
