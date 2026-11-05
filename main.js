const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, Notification, dialog, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');
const { execFile } = require('child_process');
const fortuneModule = require('./fortune/fortune-main');

app.setAppUserModelId('com.xziramoon.poshero');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const WIN_WIDTH = 400;
const WIN_HEIGHT = 700;
const WIN_MIN_WIDTH = 340;
const WIN_MIN_HEIGHT = 480;
const MINI_WIDTH = 210;
const MINI_HEIGHT = 86;
const EDGE_MARGIN = 12;
// Must match the moment renderer/theme-hero.css's #modeShutter finishes closing
// (shutter-close keyframe) — the native setBounds() for entering mini mode is
// deliberately deferred until this shutter is fully opaque, so the resize jump
// is masked instead of visible. If you retime the CSS, retime this too.
const COLLAPSE_MS = 230;

let mainWindow = null;
let tray = null;
let fortune = null; // เซียมซีต่อท้ายใบเสร็จ (fortune/) — สร้างหลัง app ready
let isPinned = true;
let isQuitting = false;
let isMiniMode = false;
let lastFullBounds = null;
let isTransitioning = false;
let transitionToken = 0;
// The "🔄 ตรวจสอบอัปเดต" tray item and the silent background checks (on
// launch, every 4h) both go through the same autoUpdater — this flag is
// how the shared event handlers below know whether to actually show a
// notification. Without it, the manual click looked completely broken
// whenever the app was already on the latest version: checkForUpdates()
// resolving to "no update" produced zero visible feedback of any kind.
let manualUpdateCheck = false;

function getDockedPosition(width, height) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const x = wa.x + wa.width - width - EDGE_MARGIN;
  const y = wa.y + wa.height - height - EDGE_MARGIN;
  return { x, y };
}

// The mini HUD used to always re-dock to the bottom-right corner on every
// entry into mini mode; the user wanted to be able to drag it anywhere and
// have it stay put. Since the whole widget is a native -webkit-app-region:
// drag area (renderer/theme-hero.css), dragging is just the OS moving the
// window — no renderer/IPC involvement needed, we just listen for the
// window's own 'moved' event below and remember where it ended up.
const MINI_POSITION_FILE = path.join(app.getPath('userData'), 'window-state.json');
let lastMiniPosition = null;
let miniPositionSaveTimer = null;

function loadMiniPosition() {
  try {
    const data = JSON.parse(fs.readFileSync(MINI_POSITION_FILE, 'utf8'));
    if (Number.isFinite(data.miniX) && Number.isFinite(data.miniY)) {
      return { x: data.miniX, y: data.miniY };
    }
  } catch (e) {}
  return null;
}

// Debounced so a real drag (which fires 'moved' continuously) doesn't hit
// disk on every pixel — only once movement has settled.
function saveMiniPosition(pos) {
  if (miniPositionSaveTimer) clearTimeout(miniPositionSaveTimer);
  miniPositionSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(MINI_POSITION_FILE, JSON.stringify({ miniX: pos.x, miniY: pos.y })); } catch (e) {}
  }, 400);
}

// Guards against a remembered position from a monitor that's no longer
// connected (laptop undocked, external display unplugged) — falls back to
// the corner instead of placing the HUD somewhere off-screen and unreachable.
function isPositionOnScreen(x, y, width, height) {
  const display = screen.getDisplayMatching({ x, y, width, height });
  const b = display.bounds;
  const overlapX = Math.min(x + width, b.x + b.width) - Math.max(x, b.x);
  const overlapY = Math.min(y + height, b.y + b.height) - Math.max(y, b.y);
  return overlapX > width * 0.3 && overlapY > height * 0.3;
}

function createWindow() {
  const { x, y } = getDockedPosition(WIN_WIDTH, WIN_HEIGHT);

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: WIN_MIN_WIDTH,
    minHeight: WIN_MIN_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    // Nothing in this UI is designed for fullscreen (it's a small
    // corner-docked widget) — without this, Chromium's default F11 handler
    // still fires and blows the window up to fill the screen.
    fullscreenable: false,
    // Matches the amber theme's --hero-bg-1 (the default theme, renderer/theme-hero.css)
    // rather than an arbitrary purple — this is what briefly shows through on the
    // newly-exposed region during a window resize, so it needs to track whatever
    // theme is actually active (renderer pushes the real value via ui:bg-color once
    // it knows the saved theme; see enterMiniMode/exitMiniMode below).
    backgroundColor: '#120d09',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The phone-notification relay's HTTP server and liveness watchdog run
      // in the main process (see startRelayServer() below), so they're
      // unaffected by this either way — but this window must still redraw
      // the money-in celebration / LED state the instant those IPC events
      // arrive, even while sitting hidden in the tray as the mini HUD.
      // Chromium's default background throttling delays exactly that.
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Fires both for a real user drag (window:mini-drag-move above calling
  // setPosition() as the user moves the mini HUD) and our own programmatic
  // setBounds()/setPosition() calls — the size check is what tells those
  // apart, since only the mini HUD's own bounds are exactly MINI_WIDTH x
  // MINI_HEIGHT. This also means dockToCorner() naturally re-remembers the
  // corner as the new mini position with no extra code.
  // 'moved' alone isn't reliable across platforms (historically macOS-only
  // in Electron) — 'move' is the one that actually fires on Windows, both
  // continuously during a real drag and once for a programmatic move.
  const onWindowMoved = () => {
    if (isTransitioning) return;
    const [w, h] = mainWindow.getSize();
    if (w !== MINI_WIDTH || h !== MINI_HEIGHT) return;
    const [x, y] = mainWindow.getPosition();
    lastMiniPosition = { x, y };
    saveMiniPosition(lastMiniPosition);
  };
  mainWindow.on('move', onWindowMoved);
  mainWindow.on('moved', onWindowMoved);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createTray() {
  const trayIconPath = path.join(__dirname, 'build', 'tray.png');
  let trayIcon = nativeImage.createFromPath(trayIconPath);
  if (!trayIcon.isEmpty()) {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('POS Hero — แตะเพื่อเปิด/ปิด');
  refreshTrayMenu();

  tray.on('click', () => {
    toggleWindow();
  });
}

function refreshTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: mainWindow && mainWindow.isVisible() ? '🫥 ซ่อนหน้าต่าง' : '👁️ แสดงหน้าต่าง', click: () => toggleWindow() },
    { label: '📌 ลอยอยู่บนสุดเสมอ', type: 'checkbox', checked: isPinned, click: (menuItem) => {
      isPinned = menuItem.checked;
      if (mainWindow) mainWindow.setAlwaysOnTop(isPinned, 'floating');
      mainWindow?.webContents.send('pin-state-changed', isPinned);
    } },
    { label: '↩️ กลับไปมุมจอ', click: () => dockToCorner() },
    { type: 'separator' },
    { label: '📱 ข้อมูลเชื่อมต่อมือถือ (IP/Token)', click: () => showRelayInfoDialog() },
    { label: fortune ? `🥠 ตั้งค่าเซียมซี (วันนี้ ${fortune.todayCount()} ใบ)` : '🥠 ตั้งค่าเซียมซี', enabled: !!fortune, click: () => fortune && fortune.openSettings() },
    { type: 'separator' },
    { label: '🔄 ตรวจสอบอัปเดต', click: () => {
      manualUpdateCheck = true;
      // The 'error' event (below) already shows a notification and covers
      // a rejected promise too — swallow here instead of duplicating that.
      autoUpdater.checkForUpdates().catch(() => {});
    } },
    { type: 'separator' },
    { label: '❌ ออกจากโปรแกรม', click: () => {
      isQuitting = true;
      app.quit();
    } }
  ]);
  tray.setContextMenu(contextMenu);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  refreshTrayMenu();
}

function dockToCorner() {
  if (!mainWindow) return;
  const [w, h] = mainWindow.getSize();
  const { x, y } = getDockedPosition(w, h);
  mainWindow.setPosition(x, y);
  mainWindow.show();
  mainWindow.focus();
}

// "Mini mode" is the TBH-style tiny widget: instead of vanishing to the
// tray, minimizing shrinks the window down to a small always-on-top HUD
// docked in the corner (coin mascot + today's net total). All the app
// logic (records, the phone-relay HTTP server) keeps running underneath — this is
// purely a window-bounds + renderer-CSS state, nothing is unloaded.
// Entering mini mode is staged in two IPC round-trips instead of one:
// 1) 'mode-transition' tells the renderer to start its shrink animation
//    (titlebar/paper/controls animate out, then a full-viewport shutter
//    closes over the content).
// 2) Only once that shutter is fully opaque — signalled by
//    'window:collapse-ready', or a COLLAPSE_MS watchdog if the renderer
//    never acks (reduced-motion, a wedged renderer, etc.) — do we actually
//    call setBounds(). Windows has no animated-resize API (BrowserWindow's
//    setBounds animate flag is macOS-only), so the real jump is hidden
//    behind the shutter rather than shown raw.
function commitEnterMini(token) {
  // isTransitioning is cleared by whichever of {renderer ack, watchdog} wins the
  // race, so the loser (same token, but isTransitioning already false) is a no-op
  // instead of double-committing setBounds()/mode-changed.
  if (token !== transitionToken || !mainWindow || !isTransitioning) return;
  mainWindow.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
  mainWindow.setResizable(false);
  // Reuse wherever the user last dragged the HUD to, unless that spot is on
  // a display that's no longer connected — then fall back to the corner.
  const { x, y } = (lastMiniPosition && isPositionOnScreen(lastMiniPosition.x, lastMiniPosition.y, MINI_WIDTH, MINI_HEIGHT))
    ? lastMiniPosition
    : getDockedPosition(MINI_WIDTH, MINI_HEIGHT);
  mainWindow.setBounds({ x, y, width: MINI_WIDTH, height: MINI_HEIGHT });
  isMiniMode = true;
  isTransitioning = false;
  mainWindow.webContents.send('mode-changed', 'mini');
}

function enterMiniMode() {
  if (!mainWindow || isMiniMode || isTransitioning) return;
  lastFullBounds = mainWindow.getBounds();
  isTransitioning = true;
  const token = ++transitionToken;
  mainWindow.webContents.send('mode-transition', { to: 'mini' });
  setTimeout(() => commitEnterMini(token), COLLAPSE_MS + 40);
}

// Exiting mini mode has no shutter-timing dependency: the window is tiny
// today and the target (full) size is known up front, so the resize can
// happen immediately — the renderer then animates the full UI assembling
// back in on top of the newly-grown window.
function exitMiniMode() {
  if (!mainWindow || !isMiniMode || isTransitioning) return;
  isTransitioning = true;
  transitionToken++;
  mainWindow.setMinimumSize(WIN_MIN_WIDTH, WIN_MIN_HEIGHT);
  mainWindow.setResizable(true);
  // Expanding always lands back at the corner — the user found it jarring
  // for the full window to reappear wherever it happened to be sitting
  // before it was last minimized, now that the mini HUD itself can be
  // dragged far from there. Width/height are still restored from
  // lastFullBounds so a manual resize survives the round-trip; only the
  // position is pinned.
  const width = lastFullBounds ? lastFullBounds.width : WIN_WIDTH;
  const height = lastFullBounds ? lastFullBounds.height : WIN_HEIGHT;
  const { x, y } = getDockedPosition(width, height);
  mainWindow.setBounds({ x, y, width, height });
  isMiniMode = false;
  mainWindow.webContents.send('mode-changed', 'full');
  mainWindow.show();
  mainWindow.focus();
  isTransitioning = false;
}

function startFortune() {
  try {
    fortune = fortuneModule.create({
      app, BrowserWindow, ipcMain, Notification,
      buildEscPosRaster,
      sendRaw: (buf, printerName) => sendRawToPrinter(buf, printerName),
      getDefaultPrinterName: async () => {
        const printers = await mainWindow.webContents.getPrintersAsync();
        const t = printers.find((x) => x.isDefault) || printers[0];
        return t ? t.name : '';
      },
      onStatsChange: () => refreshTrayMenu()
    });
    fortune.start();
    refreshTrayMenu();
  } catch (err) {
    // บั๊กในโมดูลเซียมซีต้องไม่กระทบ POS Hero
    console.error('fortune module failed to start:', err);
    fortune = null;
  }
}

app.whenReady().then(() => {
  // frame:false hides the default menu bar visually, but Electron still
  // attaches it (and its default accelerators — F11 fullscreen, Ctrl+R
  // reload, Ctrl+Shift+I devtools, etc.) unless explicitly removed. F11
  // was blowing this small corner-docked widget up to fill the screen
  // because of exactly this — fullscreenable:false alone isn't enough to
  // stop the accelerator from calling setFullScreen().
  Menu.setApplicationMenu(null);

  // ร้านต้องพึ่งแอปนี้รับเงินเข้าตลอดเวลาที่เปิดร้าน — ถ้าเครื่องรีสตาร์ท (ไฟดับ/Windows update)
  // แล้วไม่มีใครมาเปิดแอปเอง relay จะไม่รับสัญญาณจากมือถือเลยจนกว่าจะมีคนสังเกตเห็น กับรายการที่
  // พลาดไปช่วงนั้นก็ไม่มีทาง replay ได้ทีหลังด้วย (ไม่มี queue ฝั่งมือถือ) จึงต้องเปิดเองตอน
  // Windows login เสมอ (เหมือน desktop-app/main.js ของโปรเจกต์ relay ตัวเดิม)
  app.setLoginItemSettings({ openAtLogin: true });

  lastMiniPosition = loadMiniPosition();
  createWindow();
  createTray();
  startFortune();
  startRelayServer();
  startNetworkWatcher();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Sleep/lock-screen is the most common way the Pushbullet socket dies
  // silently. Don't wait for the 10s health-check to notice — force a
  // reconnect the moment the machine is usable again.
  const forceReconnect = () => mainWindow?.webContents.send('force-reconnect-pushbullet');
  powerMonitor.on('resume', forceReconnect);
  powerMonitor.on('unlock-screen', forceReconnect);

  // Auto-update: only meaningful for an installed/packaged build — in dev
  // (npm start) electron-updater no-ops since there's no packaged app to
  // replace. Check once on launch, then every 4 hours while it keeps running
  // in the tray.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
});

autoUpdater.on('update-available', (info) => {
  if (!manualUpdateCheck) return; // background checks stay silent until there's actually a downloaded file to act on
  manualUpdateCheck = false;
  if (!Notification.isSupported()) return;
  new Notification({
    title: '⬇️ พบอัปเดตใหม่ (v' + info.version + ')',
    body: 'กำลังดาวน์โหลด... จะแจ้งเตือนอีกครั้งเมื่อพร้อมติดตั้ง',
    icon: path.join(__dirname, 'build', 'icon.ico')
  }).show();
});

autoUpdater.on('update-not-available', () => {
  if (!manualUpdateCheck) return; // only the manual tray click cares to hear "nothing to do"
  manualUpdateCheck = false;
  if (!Notification.isSupported()) return;
  new Notification({
    title: '✅ เป็นเวอร์ชันล่าสุดแล้ว',
    body: 'ไม่มีอัปเดตใหม่ในขณะนี้ (v' + app.getVersion() + ')',
    icon: path.join(__dirname, 'build', 'icon.ico')
  }).show();
});

autoUpdater.on('update-downloaded', (info) => {
  manualUpdateCheck = false;
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: '🔄 มีอัปเดตใหม่ (v' + info.version + ')',
    body: 'ดาวน์โหลดเสร็จแล้ว คลิกเพื่อรีสตาร์ทแล้วอัปเดตทันที (หรือปล่อยไว้ จะอัปเดตให้เองตอนปิดโปรแกรมครั้งถัดไป)',
    icon: path.join(__dirname, 'build', 'icon.ico')
  });
  notif.on('click', () => {
    isQuitting = true;
    autoUpdater.quitAndInstall();
  });
  notif.show();
});

autoUpdater.on('error', (err) => {
  console.error('[autoUpdater]', err == null ? 'unknown error' : (err.stack || err.message || err));
  if (!manualUpdateCheck) return; // background checks fail silently (retried every 4h anyway); don't nag the user for something they didn't ask about
  manualUpdateCheck = false;
  if (!Notification.isSupported()) return;
  new Notification({
    title: '❌ ตรวจสอบอัปเดตไม่สำเร็จ',
    body: (err && err.message) || 'ไม่สามารถเชื่อมต่อเพื่อตรวจสอบอัปเดตได้ ลองใหม่อีกครั้ง',
    icon: path.join(__dirname, 'build', 'icon.ico')
  }).show();
});

app.on('window-all-closed', () => {
  // Widget lives in the tray; do not quit when the window closes.
});

// Receipt printing: the native OS print dialog (window.print()'s default
// path) ignores the page's CSS @page size entirely and just uses whatever
// paper size is sitting in the driver/dialog — which is how a thermal
// receipt printer ends up printing a full A4-length sheet. Printing
// silently, with no dialog in the way, is what actually respects the
// CSS-declared 80mm page size (and is nicer for a cashier anyway — no
// dialog to click through on every receipt).
// Receipt printing bypasses webContents.print() entirely — see
// hero-chrome.js's heroPrint() for the full "why" (that path can't win:
// the EPSON TM-T82III driver only accepts two page heights, and whichever
// one you request, either the driver or Chromium pads the rest of it with
// blank paper). Instead: screenshot the receipt element exactly as
// rendered (webContents.capturePage — no page/media concept involved),
// threshold it to 1-bit, and send it as a raw ESC/POS image straight to
// the printer via Win32 WritePrinter (build/raw-print.ps1), which prints
// exactly as many dot-rows as the image actually has and nothing more.
const RECEIPT_DOT_WIDTH = 576; // 72mm printable width (80mm roll - 4mm margins/side) at 203dpi; /8 = 72 exactly, so byte-aligned with no partial-byte row padding

function buildEscPosRaster(bitmapBGRA, widthPx, heightPx, opts = {}) {
  // opts.init === false omits ESC @ (ใช้ตอนพิมพ์ต่อท้ายงานที่ค้างอยู่บนกระดาษ — fortune/); ค่าเริ่มต้นไบต์เท่าเดิมทุกไบต์
  const bytesPerRow = Math.ceil(widthPx / 8);
  // Bands of 256 dot-rows mirror how the OEM driver's own raster output was
  // structured (observed while diagnosing the page-size bug) — keeps each
  // GS v 0 command comfortably within typical printer receive-buffer limits
  // instead of gambling on one command covering the whole receipt.
  const BAND_HEIGHT = 256;
  // Print CSS already forces pure black text/borders (`color:#000 !important`)
  // on a white background plus `filter: grayscale(1)`, so this only needs to
  // reliably split those two, not handle real grayscale/anti-aliased input.
  const LUMINANCE_THRESHOLD = 160;

  const chunks = opts.init === false ? [] : [Buffer.from([0x1b, 0x40])]; // ESC @ — initialize printer

  for (let bandStart = 0; bandStart < heightPx; bandStart += BAND_HEIGHT) {
    const bandHeight = Math.min(BAND_HEIGHT, heightPx - bandStart);
    const raster = Buffer.alloc(bytesPerRow * bandHeight, 0);
    for (let y = 0; y < bandHeight; y++) {
      const srcY = bandStart + y;
      for (let x = 0; x < widthPx; x++) {
        const srcIdx = (srcY * widthPx + x) * 4;
        const b = bitmapBGRA[srcIdx], g = bitmapBGRA[srcIdx + 1], r = bitmapBGRA[srcIdx + 2], a = bitmapBGRA[srcIdx + 3];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a > 10 && luminance < LUMINANCE_THRESHOLD) {
          raster[y * bytesPerRow + (x >> 3)] |= (0x80 >> (x & 7));
        }
      }
    }
    const xL = bytesPerRow & 0xff, xH = (bytesPerRow >> 8) & 0xff;
    const yL = bandHeight & 0xff, yH = (bandHeight >> 8) & 0xff;
    chunks.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH])); // GS v 0 — print raster bit image
    chunks.push(raster);
  }

  chunks.push(Buffer.from([0x1b, 0x64, 0x02])); // ESC d 2 — feed 2 lines, a small cut margin
  chunks.push(Buffer.from([0x1d, 0x56, 0x41, 0x00])); // GS V 65 0 — full cut, no extra feed (matches the OEM driver's own cut command)
  return Buffer.concat(chunks);
}

// ใบเสร็จยาวกว่าหน้าต่าง (เช่น "พิมพ์ (เต็ม)" ที่มีหลายสิบรายการ) จับภาพครั้งเดียวไม่ได้ — capturePage
// ได้แค่ส่วนที่อยู่ในหน้าต่าง (สูง ~700px) ส่วนที่เลยขอบล่างถูกตัดทิ้ง renderer (hero-chrome.js heroPrint)
// จึงเลื่อนใบเสร็จขึ้นทีละหน้าจอแล้วส่งมาให้จับทีละช่วง (print:capture-slice) ฝั่งนี้ต่อภาพดิบ (ความละเอียดจริง
// ของจอ) เป็นแผ่นเดียว แล้วค่อยย่อเป็น 576 จุดครั้งเดียวตอนท้าย — ย่อทีละช่วงจะมีรอยต่อจากการปัดเศษ
const printJobs = new Map(); // jobId → { slices: [{ bitmap, width, height }], createdAt }
const PRINT_JOB_TTL_MS = 2 * 60 * 1000;

ipcMain.handle('print:capture-slice', async (_event, { jobId, rect } = {}) => {
  if (!mainWindow) return { success: false, reason: 'no window' };
  if (typeof jobId !== 'string' || !rect || !(rect.width > 0) || !(rect.height > 0)) return { success: false, reason: 'invalid capture rect' };
  for (const [id, job] of printJobs) if (Date.now() - job.createdAt > PRINT_JOB_TTL_MS) printJobs.delete(id);
  try {
    const captured = await mainWindow.webContents.capturePage({
      x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height
    });
    const size = captured.getSize();
    const job = printJobs.get(jobId) || { slices: [], createdAt: Date.now() };
    job.slices.push({ bitmap: captured.toBitmap(), width: size.width, height: size.height });
    printJobs.set(jobId, job);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err && err.message ? err.message : String(err) };
  }
});

function stitchSlices(slices) {
  const width = Math.min(...slices.map(s => s.width));
  const height = slices.reduce((h, s) => h + s.height, 0);
  const out = Buffer.alloc(width * height * 4);
  let y0 = 0;
  for (const s of slices) {
    for (let y = 0; y < s.height; y++) {
      s.bitmap.copy(out, ((y0 + y) * width) * 4, (y * s.width) * 4, (y * s.width + width) * 4);
    }
    y0 += s.height;
  }
  return nativeImage.createFromBitmap(out, { width, height });
}

// ส่งไบต์ ESC/POS ดิบเข้าเครื่องพิมพ์ผ่าน build/raw-print.ps1 (ชื่องาน "POS Hero Receipt")
// printerName ว่าง = เครื่องพิมพ์ default ของ Windows (เหมือนเดิม) — ใช้ร่วมกันระหว่างใบเสร็จกับ fortune/
async function sendRawToPrinter(escpos, printerName) {
  const tmpFile = path.join(os.tmpdir(), `pos-hero-receipt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`);
  try {
    fs.writeFileSync(tmpFile, escpos);
    let name = printerName;
    if (!name) {
      const printers = await mainWindow.webContents.getPrintersAsync();
      const target = printers.find((p) => p.isDefault) || printers[0];
      if (!target) return { success: false, reason: 'ไม่พบเครื่องพิมพ์ในระบบ' };
      name = target.name;
    }
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'raw-print.ps1')
      : path.join(__dirname, 'build', 'raw-print.ps1');
    return await new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-PrinterName', name, '-FilePath', tmpFile
      ], { windowsHide: true }, (error, _stdout, stderr) => {
        resolve(error ? { success: false, reason: (stderr || error.message).trim() } : { success: true, reason: '' });
      });
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

ipcMain.handle('print:raw', async (_event, arg) => {
  if (!mainWindow) return { success: false, reason: 'no window' };

  try {
    let captured;
    if (arg && typeof arg.jobId === 'string') {
      const job = printJobs.get(arg.jobId);
      printJobs.delete(arg.jobId);
      if (!job || !job.slices.length) return { success: false, reason: 'ไม่มีภาพใบเสร็จให้พิมพ์' };
      captured = stitchSlices(job.slices);
    } else {
      // แบบเดิม: จับภาพครั้งเดียวจาก rect (ใบสั้นที่อยู่ในหน้าต่างทั้งใบ)
      const rect = arg;
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { success: false, reason: 'invalid capture rect' };
      captured = await mainWindow.webContents.capturePage({
        x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height
      });
    }
    const resized = captured.resize({ width: RECEIPT_DOT_WIDTH, quality: 'best' });
    const size = resized.getSize();
    const escpos = buildEscPosRaster(resized.toBitmap(), size.width, size.height);

    return await sendRawToPrinter(escpos);
  } catch (err) {
    return { success: false, reason: err && err.message ? err.message : String(err) };
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.on('window:minimize', () => {
  mainWindow?.hide();
  refreshTrayMenu();
});

ipcMain.on('window:close', () => {
  mainWindow?.hide();
  refreshTrayMenu();
});

ipcMain.on('window:toggle-pin', () => {
  isPinned = !isPinned;
  mainWindow?.setAlwaysOnTop(isPinned, 'floating');
  mainWindow?.webContents.send('pin-state-changed', isPinned);
});

ipcMain.handle('window:get-pin-state', () => isPinned);

ipcMain.on('window:dock-to-corner', () => {
  dockToCorner();
});

ipcMain.on('window:enter-mini', () => {
  enterMiniMode();
});

ipcMain.on('window:exit-mini', () => {
  exitMiniMode();
});

// Custom mini-HUD dragging. -webkit-app-region:drag on the whole clickable
// widget (the first attempt at this) turned out to swallow real mouse
// clicks in practice on real hardware — a synthetic test click has zero
// pixel jitter and worked fine under Playwright, but an actual human click
// always moves the cursor a pixel or two, and Windows' own drag-region
// hit-testing treated that as "drag started" and ate the click. Doing the
// drag ourselves with an explicit distance threshold (renderer/hero-chrome.js)
// is forgiving of that jitter; here we just move the window by however far
// the OS cursor has moved since the drag started, read directly rather than
// trusting renderer mouse-event coordinates (which stop arriving if the
// cursor ever outruns this tiny, constantly-repositioning window).
let miniDragOrigin = null; // { cursorX, cursorY, winX, winY }

ipcMain.on('window:mini-drag-start', () => {
  if (!mainWindow || !isMiniMode) return;
  const cursor = screen.getCursorScreenPoint();
  const [winX, winY] = mainWindow.getPosition();
  miniDragOrigin = { cursorX: cursor.x, cursorY: cursor.y, winX, winY };
});

ipcMain.on('window:mini-drag-move', () => {
  if (!mainWindow || !miniDragOrigin) return;
  const cursor = screen.getCursorScreenPoint();
  mainWindow.setPosition(
    miniDragOrigin.winX + (cursor.x - miniDragOrigin.cursorX),
    miniDragOrigin.winY + (cursor.y - miniDragOrigin.cursorY)
  );
});

ipcMain.on('window:mini-drag-end', () => {
  miniDragOrigin = null;
});

// Ack from the renderer that its shutter has finished closing — commit the
// real resize now instead of waiting out the full COLLAPSE_MS watchdog.
ipcMain.on('window:collapse-ready', () => {
  commitEnterMini(transitionToken);
});

// The window's backgroundColor briefly shows through the newly-exposed
// region on a grow (see the BrowserWindow constructor comment) — keep it
// synced to whichever theme's --hero-bg-1 the renderer actually has active.
ipcMain.on('ui:bg-color', (_event, hex) => {
  if (mainWindow && typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    mainWindow.setBackgroundColor(hex);
  }
});

ipcMain.on('money:in', (_event, payload) => {
  const amount = Number(payload && payload.amount) || 0;
  const name = ((payload && payload.name) || 'ลูกค้าโอน').toString().slice(0, 60);
  const typeLabels = { transfer: 'โอน', welfare: 'บัตรรัฐ', thaiplus: 'ไทยพลัส', expense: 'ค่าใช้จ่าย' };
  const typeLabel = typeLabels[payload && payload.type] || 'โอน';

  if (!Notification.isSupported() || amount <= 0) return;

  const notif = new Notification({
    title: '💰 เงินเข้า +' + amount.toLocaleString('en-US') + ' ฿',
    body: name + ' • ' + typeLabel,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    silent: false
  });

  notif.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    refreshTrayMenu();
  });

  notif.show();
});

// Pushbullet (ช่องทางเดิม นำกลับมาใช้คู่กับ relay) — REST poll ย้อนหลัง
// หมายเหตุ: /v2/pushes คืนเฉพาะ push ที่ถูกเก็บไว้บนเซิร์ฟเวอร์เท่านั้น แจ้งเตือนที่ mirror
// จากมือถือ (type 'mirror') เป็น ephemeral ไม่ถูกเก็บในรายการนี้เลย — poll นี้จึงกู้ได้แค่
// push ปกติ ไม่ครอบคลุม mirror ช่วงที่ WebSocket หลุดไป (ช่องทาง Firebase inbox กู้ส่วนนั้นแทน)
// Runs in main (not renderer) so it isn't subject to renderer CORS/webSecurity at all.
ipcMain.handle('pb:poll-missed', async (_event, { token, sinceTs }) => {
  try {
    const res = await fetch(
      `https://api.pushbullet.com/v2/pushes?modified_after=${encodeURIComponent(sinceTs)}&active=true`,
      { headers: { 'Access-Token': token } }
    );
    if (!res.ok) return { success: false, reason: 'http ' + res.status };
    const data = await res.json();
    return { success: true, pushes: data.pushes || [] };
  } catch (e) {
    return { success: false, reason: e.message };
  }
});

// ยิงจาก renderer เมื่อ "ไฟรวม" ทุกช่องทางเป็นแดงเกิน 1 นาที (ไม่ใช่แค่ Pushbullet หลุด)
ipcMain.on('pb:disconnected-warning', (_event, downMinutes) => {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: '⚠️ ไม่มีช่องทางรับเงินเข้าที่ทำงาน',
    body: `Firebase / วงเน็ต / Pushbullet เงียบทั้งหมดมา ${downMinutes} นาทีแล้ว อาจพลาดยอดเงินเข้า — เช็คเน็ตคอม/มือถือดักจับ แล้วเปิดแอปนี้ขึ้นมาดู`,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    urgency: 'critical'
  });
  notif.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    refreshTrayMenu();
  });
  notif.show();
});

// ==========================================
// Phone-notification relay — embedded LAN HTTP server (replaces Pushbullet)
// ==========================================
// Same role Pushbullet used to play, but running entirely inside this app's
// own main process instead of a third-party cloud relay: the Android app
// (android-app/, a separate project — see its README) parses bank/wallet
// notifications on the phone itself and POSTs only a structured payment
// event over LAN — never the raw notification text. This server accepts
// that event, validates it, and hands it to the renderer via IPC.
const RELAY_CONFIG_PATH = path.join(app.getPath('userData'), 'relay-config.json');
const RELAY_DEFAULT_PORT = 8788; // deliberately different from the standalone
// "POS Notification Relay" product's default (8787) so both can run on the
// same LAN/machine without a port clash if a shop happens to use both.

function loadRelayConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, 'utf8')); } catch (e) { cfg = {}; }
  let changed = false;
  if (!cfg.token) { cfg.token = crypto.randomBytes(16).toString('hex'); changed = true; }
  if (!cfg.port) { cfg.port = RELAY_DEFAULT_PORT; changed = true; }
  if (changed) {
    try { fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { /* ไม่มี config ถาวรก็ยังใช้ค่าที่สุ่มไว้ในหน่วยความจำได้ต่อไปในเซสชันนี้ */ }
  }
  return cfg;
}

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const relayConfig = loadRelayConfig();

// allow-list ของ source ที่รู้จัก — ต้องตรงกับ sources[] ใน android-app/parser-spec/patterns.json
// (โปรเจกต์แยกกัน คนละ repo กับ pos-hero นี้) ไม่ได้ import ไฟล์นั้นมาตรงๆ เพราะ pos-hero ไม่ได้
// bundle android-app ไว้ด้วย — ถ้าเพิ่ม source ใหม่ฝั่ง android-app ต้องมาแก้ที่นี่ด้วยมือ
const ALLOWED_RELAY_SOURCES = new Set([
  'kplus', 'scb', 'ktb', 'bbl', 'krungsri', 'ttb',
  'truemoney', 'paotang', 'thungngern', 'maemanee', 'unknown'
]);
const RELAY_EVENT_ID_RE = /^[a-f0-9]{32}$/;

// กันรายการซ้ำด้วย event_id (เช่น android-app รีทรานส่งเพราะไม่เห็น response ทันเวลา)
const RELAY_DEDUPE_TTL_MS = 10 * 60 * 1000;
const seenRelayEventIds = new Map();
function isDuplicateRelayEvent(eventId) {
  const now = Date.now();
  if (seenRelayEventIds.has(eventId)) return true;
  seenRelayEventIds.set(eventId, now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seenRelayEventIds) {
    if (now - ts > RELAY_DEDUPE_TTL_MS) seenRelayEventIds.delete(id);
  }
}, 60 * 1000).unref();

// lastRelayActivity คือหัวใจของ LED สถานะ (แทนที่ readyState ของ WebSocket เดิม) — อัปเดตทุกครั้งที่
// ได้รับ /ping หรือ /notify ที่ผ่าน auth แล้ว ไม่ว่า payload จะ valid หรือไม่ก็ตาม (แค่ต้องมี token ถูก
// ก็พอถือว่า "มือถือยังส่งสัญญาณมาอยู่")
let lastRelayActivity = 0;
let relayEverSeen = false;
let relayIsDown = false;
const RELAY_OK_WINDOW_MS = 130 * 1000; // ~2 heartbeat รอบ (60s/รอบ) ของ android-app เผื่อ jitter/หลุด 1 ครั้ง

function sendRelayStatus() {
  const state = !relayEverSeen ? 'unconfigured' : (relayIsDown ? 'err' : 'ok');
  mainWindow?.webContents.send('relay:status', { state, lastActivity: lastRelayActivity });
}

// ตรวจทุก 10 วิ (เท่าของเดิม) — ไม่มี WebSocket ให้ onclose บอกเราอีกต่อไป ต้องเดาจาก "เงียบไปนานแค่ไหน" แทน
setInterval(() => {
  if (!relayEverSeen) return;
  const downFor = Date.now() - lastRelayActivity;
  const nowDown = downFor > RELAY_OK_WINDOW_MS;
  if (nowDown !== relayIsDown) {
    relayIsDown = nowDown;
    sendRelayStatus();
  }
  // native notification เตือนหลุดย้ายไปยิงตาม "ไฟรวม" ทุกช่องทางใน renderer แล้ว
  // (pb:disconnected-warning) — relay นี้เงียบแต่ Firebase/วงเน็ตยังรับได้ ไม่ต้องเด้งเตือน
}, 10000);

function handleRelayRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'POS Hero relay' }));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/ping' || url.pathname === '/notify')) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== relayConfig.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
      return;
    }

    // แรกที่เห็นมือถือเลย (relayEverSeen false→true) ก็ต้องแจ้ง renderer ให้พ้นสถานะ
    // "unconfigured" เหมือนกับตอนฟื้นจาก err→ok — ทั้งสองกรณีคือ "สถานะที่ LED โชว์เปลี่ยนไป"
    const wasDownOrUnseen = relayIsDown || !relayEverSeen;
    relayEverSeen = true;
    lastRelayActivity = Date.now();
    relayIsDown = false;
    if (wasDownOrUnseen) sendRelayStatus();

    if (url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        let data;
        try { data = JSON.parse(body); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        if (!data || typeof data !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }

        const errors = [];
        if (data.v !== 1) errors.push('v');
        if (typeof data.event_id !== 'string' || !RELAY_EVENT_ID_RE.test(data.event_id)) errors.push('event_id');
        if (typeof data.amount !== 'number' || !Number.isFinite(data.amount) || data.amount <= 0 || data.amount > 999999) errors.push('amount');
        if (typeof data.currency !== 'string' || data.currency.length === 0) errors.push('currency');

        let isTest = false;
        if (data.is_test === undefined) { isTest = false; }
        else if (typeof data.is_test === 'boolean') { isTest = data.is_test; }
        else { errors.push('is_test'); }

        if (typeof data.source !== 'string' || data.source.length === 0) {
          errors.push('source');
        } else if (isTest) {
          if (data.source !== 'test') errors.push('source');
        } else {
          if (data.source === 'test' || !ALLOWED_RELAY_SOURCES.has(data.source)) errors.push('source');
        }

        if (typeof data.occurred_at !== 'number' || !Number.isFinite(data.occurred_at)) errors.push('occurred_at');

        // sender_name เป็นฟิลด์ใหม่ (optional) — มือถือส่งมาแบบ best-effort เท่านั้น ไม่ใช่ทุกแหล่งที่มา
        // จะมีให้เสมอ ถ้าไม่ส่งมาเลยก็ไม่ error, แต่ถ้าส่งมาต้องเป็น string เท่านั้น
        let senderName = null;
        if (data.sender_name !== undefined) {
          if (typeof data.sender_name !== 'string') {
            errors.push('sender_name');
          } else {
            senderName = data.sender_name.trim().slice(0, 100) || null;
          }
        }

        if (errors.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_payload', fields: errors }));
          return;
        }

        if (isDuplicateRelayEvent(data.event_id)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, duplicate: true }));
          return;
        }

        const payload = {
          type: 'payment',
          v: 1,
          event_id: data.event_id,
          amount: data.amount,
          currency: data.currency,
          source: data.source,
          source_package: String(data.source_package || ''),
          occurred_at: data.occurred_at,
          is_test: isTest,
          sender_name: senderName
        };
        mainWindow?.webContents.send('payment:event', payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

function startRelayServer() {
  const server = http.createServer((req, res) => {
    try {
      handleRelayRequest(req, res);
    } catch (e) {
      console.error('[RELAY] เกิดข้อผิดพลาดขณะจัดการ request:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[RELAY] พอร์ต ${relayConfig.port} ถูกใช้งานอยู่แล้ว — อาจเปิด POS Hero ซ้ำสองชุด`);
    } else {
      console.error('[RELAY] เกิดข้อผิดพลาดขณะเปิด relay server:', err);
    }
  });
  server.listen(relayConfig.port);
}

function showRelayInfoDialog() {
  const ips = getLanIPs();
  const ipLines = ips.length
    ? ips.map(ip => `  Server: ${ip}:${relayConfig.port}`).join('\n')
    : '  ไม่พบ IP วง LAN — ตรวจสอบว่าเครื่องนี้ต่อ WiFi/LAN อยู่';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'ข้อมูลเชื่อมต่อมือถือ',
    message: 'ตั้งค่าในแอป "POS Relay" บนมือถือ',
    detail: `${ipLines}\n  Token: ${relayConfig.token}\n\nใส่ค่าเดียวกันนี้ในแอปมือถือ (Notification Relay app) แล้วกดทดสอบเชื่อมต่อ`,
    buttons: ['ปิด']
  });
}

ipcMain.handle('relay:get-info', () => ({
  ips: getLanIPs(),
  port: relayConfig.port,
  token: relayConfig.token
}));

// ==========================================
// ตัวเฝ้าเครือข่าย (Phase 1) — สลับ Wi-Fi ร้าน → ฮอตสปอตมือถือ ไม่ทำให้ navigator.onLine เป็น
// false เลย (มีเน็ตตลอด แค่เปลี่ยนการ์ด/IP) event 'online' ฝั่ง renderer จึงไม่ยิง และ socket เดิม
// ค้างอยู่บน route เก่าจนกว่า watchdog จะจับได้ (~40 วิ) — เช็ค IPv4 ที่ไม่ใช่ internal ทุก 4 วิแทน
// ถ้าชุด (ชื่อการ์ด + address) เปลี่ยน → บอกทุกช่องทางให้ต่อ/bind ใหม่ทันที
// ==========================================
const NETWORK_POLL_MS = 4000;
const networkChangeHooks = []; // ช่องทางฝั่ง main (Firebase/UDP) ลงทะเบียนไว้เพื่อ reconnect/rebind
let lastNetworkSig = null;

function readNetworkSignature() {
  const nets = os.networkInterfaces();
  const parts = [];
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        parts.push(name + '=' + net.address);
        ips.push(net.address);
      }
    }
  }
  parts.sort();
  return { sig: parts.join('|'), ips };
}

function startNetworkWatcher() {
  lastNetworkSig = readNetworkSignature().sig;
  setInterval(() => {
    const { sig, ips } = readNetworkSignature();
    if (sig === lastNetworkSig) return;
    lastNetworkSig = sig;
    for (const hook of networkChangeHooks) {
      try { hook(ips); } catch (e) { console.error('[NET] hook error:', e); }
    }
    mainWindow?.webContents.send('network-changed', { ips });
    mainWindow?.webContents.send('force-reconnect-pushbullet');
  }, NETWORK_POLL_MS).unref();
}

// ==========================================
// 📥 Inbox — ช่องทางรับแจ้งเตือนเงินเข้าจากมือถือ (MacroDroid) แบบทนเน็ตร้านดับ
// ==========================================
// ช่องทางหลัก: Firebase Realtime Database (REST + SSE — ไม่ใช้ Firebase JS SDK)
// ช่องทางสำรอง: UDP broadcast ในวงเน็ตเดียวกัน (LanInbox ด้านล่าง)
// ทุกช่องทางส่ง event รูปเดียวกันไป renderer ผ่าน IPC 'inbox:event':
//   { channel: 'fb'|'lan', id: pushId|null, eventId, title, body, app, ts }
// renderer (app.js ส่วนที่ 12) เป็นคนกันซ้ำข้ามช่องทาง / แยกยอด / ดึงชื่อ ด้วยโค้ดเดิมของ Pushbullet
const INBOX_KEY_RE = /^[A-Za-z0-9_-]{32,}$/;
let inboxConfig = { dbUrl: '', inboxKey: '', fbEnabled: false, lastKey: '', lanEnabled: false, lanPort: 47800 };

function sendInbox(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}
function inboxLog(msg, type) {
  sendInbox('inbox:log', { msg, type: type || 'i' });
}

// SSE ของ Firebase: บรรทัด "event: put" / "data: {...}" คั่นแต่ละ event ด้วยบรรทัดว่าง
class SseStream {
  constructor(url, { onOpen, onEvent, onClose }) {
    this.url = url;
    this.onOpen = onOpen;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.abort = null;
    this.closed = false;
  }

  async start() {
    this.abort = new AbortController();
    let reason = 'สตรีมปิด';
    try {
      const res = await fetch(this.url, { headers: { Accept: 'text/event-stream' }, signal: this.abort.signal });
      if (!res.ok) throw new Error('http ' + res.status);
      this.onOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let evType = null;
      let dataLines = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) > -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (evType) {
              let data = null;
              try { data = JSON.parse(dataLines.join('\n')); } catch (e) { data = null; }
              this.onEvent(evType, data);
            }
            evType = null;
            dataLines = [];
          } else if (line.startsWith('event:')) {
            evType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
      }
    } catch (e) {
      reason = e.name === 'AbortError' ? 'ยกเลิก' : e.message;
    }
    if (!this.closed) { this.closed = true; this.onClose(reason); }
  }

  stop() {
    this.closed = true;
    try { this.abort?.abort(); } catch (e) { /* ปิดไปแล้ว */ }
  }
}

// ------------------------------------------
// FirebaseInbox — ช่องทางหลัก
// ------------------------------------------
const FB_WATCHDOG_MS = 45 * 1000;              // Firebase ส่ง keep-alive ทุก ~30 วิ
const FB_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const FB_RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // เก็บแจ้งเตือนดิบไว้ 2 วัน
const FB_CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

// push id ของ Firebase ขึ้นต้นด้วยเวลา (ms) 8 ตัวอักษร — ใช้สร้าง cursor เริ่มต้นเป็น "ตอนนี้"
// ครั้งแรกที่เปิดใช้ กันดึงแจ้งเตือนเก่าย้อนหลัง 2 วันมาบันทึกซ้ำ
function pushIdPrefixForTime(ms) {
  let s = '';
  for (let i = 0; i < 8; i++) { s = PUSH_CHARS.charAt(ms % 64) + s; ms = Math.floor(ms / 64); }
  return s;
}

const fbInbox = {
  gen: 0,
  stream: null,
  hbStream: null,
  state: 'off',          // off | connecting | ok | err
  lastActivity: 0,
  backoffIdx: 0,
  reconnectTimer: null,
  delivered: new Set(),  // pushId ที่ส่งให้ renderer แล้วในรอบนี้ (ยังไม่ ack ก็ไม่ส่งซ้ำ)
  heartbeat: null,       // { ts, battery }
  lastCleanupAt: 0,
  lastError: ''          // [ข้อ 11/16] ข้อความ error ล่าสุด (แปลเป็นภาษาคนแล้ว) ให้ renderer โชว์ในกล่อง 📥
};

function fbConfigured() {
  return inboxConfig.fbEnabled && /^https:\/\//.test(inboxConfig.dbUrl) && INBOX_KEY_RE.test(inboxConfig.inboxKey);
}
function fbBase() {
  return inboxConfig.dbUrl.replace(/\/+$/, '') + '/pos_hero_inbox/' + inboxConfig.inboxKey;
}
function fbEventsQuery() {
  return fbBase() + '/events.json?orderBy=' + encodeURIComponent('"$key"') + '&startAt=' + encodeURIComponent(JSON.stringify(inboxConfig.lastKey));
}

function fbSetState(state) {
  if (fbInbox.state === state) return;
  fbInbox.state = state;
  sendInboxStatus();
}

function fbDeliver(id, v) {
  if (!v || typeof v !== 'object' || id <= inboxConfig.lastKey || fbInbox.delivered.has(id)) return;
  fbInbox.delivered.add(id);
  sendInbox('inbox:event', {
    channel: 'fb',
    id,
    eventId: String(v.eventId || ''),
    title: String(v.title || ''),
    body: String(v.text || ''),
    app: String(v.app || v.pkg || ''),
    ts: typeof v.ts === 'number' ? v.ts : Date.now()
  });
}
function fbDeliverAll(obj) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).sort().forEach(id => fbDeliver(id, obj[id]));
}

function fbStop() {
  fbInbox.gen++;
  if (fbInbox.reconnectTimer) { clearTimeout(fbInbox.reconnectTimer); fbInbox.reconnectTimer = null; }
  fbInbox.stream?.stop();
  fbInbox.hbStream?.stop();
  fbInbox.stream = null;
  fbInbox.hbStream = null;
}

// [ข้อ 16 feedback แอ๋ม] ข้อความ error ดิบอย่าง "http 404"/"fetch failed" อ่านไม่รู้เรื่องสำหรับคนร้าน
// — แปลเป็นภาษาคนแนบไว้ (ไม่ทิ้งข้อความดิบเดิม เผื่อ dev ต้องไล่ปัญหาต่อ)
function humanizeFbError(raw) {
  const m = String(raw || '');
  if (/http 404/.test(m)) return 'ไม่พบ URL นี้ (Database URL หรือ Inbox Key ผิด?)';
  if (/http 401/.test(m)) return 'ไม่มีสิทธิ์อ่าน (ตรวจกฎ Firebase — ดูคู่มือขั้นที่ 0)';
  if (/http 400/.test(m)) return 'คำขอไม่ถูกต้อง (URL ผิดรูปแบบ?)';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(m)) return 'ต่ออินเทอร์เน็ตไม่ได้';
  if (/timeout|aborted/i.test(m)) return 'เชื่อมต่อช้าเกินไป (timeout)';
  return '';
}

function fbScheduleReconnect(reason) {
  if (!fbConfigured()) return;
  const wait = FB_BACKOFF_MS[Math.min(fbInbox.backoffIdx, FB_BACKOFF_MS.length - 1)];
  fbInbox.backoffIdx++;
  const human = humanizeFbError(reason);
  fbInbox.lastError = human || reason;
  inboxLog(`☁️ Firebase หลุด (${human ? reason + ' — ' + human : reason}) → ต่อใหม่ใน ${wait / 1000} วิ`, 'w');
  fbSetState('err');
  if (fbInbox.reconnectTimer) clearTimeout(fbInbox.reconnectTimer);
  fbInbox.reconnectTimer = setTimeout(() => { fbInbox.reconnectTimer = null; fbConnect(); }, wait);
}

async function fbConnect() {
  fbStop();
  if (!fbConfigured()) { fbSetState('off'); return; }
  const gen = fbInbox.gen;
  fbSetState('connecting');
  fbInbox.lastActivity = Date.now();

  if (!inboxConfig.lastKey) {
    inboxConfig.lastKey = pushIdPrefixForTime(Date.now());
    sendInbox('inbox:cursor', { lastKey: inboxConfig.lastKey });
  }

  // 1) ดึงของค้างทุกอย่างที่ key > lastKey — นี่คือการกู้รายการช่วงที่หลุด/ปิดแอปไป
  try {
    const res = await fetch(fbEventsQuery(), { signal: AbortSignal.timeout(15000) });
    if (gen !== fbInbox.gen) return;
    if (!res.ok) throw new Error('http ' + res.status + (res.status === 401 ? ' (กฎ Firebase ไม่อนุญาต)' : ''));
    const data = await res.json();
    if (gen !== fbInbox.gen) return;
    const count = data && typeof data === 'object' ? Object.keys(data).filter(k => k > inboxConfig.lastKey).length : 0;
    fbDeliverAll(data);
    sendInbox('inbox:fb-backfill', { ok: true, count });
  } catch (e) {
    if (gen !== fbInbox.gen) return;
    sendInbox('inbox:fb-backfill', { ok: false, reason: e.message });
    fbScheduleReconnect('ดึงของค้างไม่ได้: ' + e.message);
    return;
  }

  // 2) เปิด SSE รับรายการใหม่แบบ realtime
  const stream = new SseStream(fbEventsQuery(), {
    onOpen: () => {
      if (gen !== fbInbox.gen) return;
      fbInbox.backoffIdx = 0;
      fbInbox.lastActivity = Date.now();
      fbSetState('ok');
    },
    onEvent: (type, msg) => {
      if (gen !== fbInbox.gen) return;
      fbInbox.lastActivity = Date.now();
      if (type === 'keep-alive') return;
      if (type === 'cancel' || type === 'auth_revoked') {
        stream.stop();
        fbScheduleReconnect(type === 'cancel' ? 'ไม่มีสิทธิ์อ่าน (ตรวจกฎ Firebase)' : 'auth_revoked');
        return;
      }
      if (!msg || typeof msg.path !== 'string') return;
      if (type === 'put') {
        if (msg.path === '/') fbDeliverAll(msg.data);
        else if (/^\/[^/]+$/.test(msg.path)) fbDeliver(msg.path.slice(1), msg.data);
      } else if (type === 'patch' && msg.path === '/') {
        fbDeliverAll(msg.data);
      }
    },
    onClose: (reason) => {
      if (gen !== fbInbox.gen) return;
      fbScheduleReconnect(reason);
    }
  });
  fbInbox.stream = stream;
  stream.start();

  // 3) heartbeat ของมือถือดักจับ (MacroDroid PUT ทุก 5 นาที) ฟังแยกอีกสตรีม
  const hbStream = new SseStream(fbBase() + '/heartbeat.json', {
    onOpen: () => {},
    onEvent: (type, msg) => {
      if (gen !== fbInbox.gen || !msg || typeof msg.path !== 'string') return;
      fbInbox.lastActivity = Date.now();
      if (type === 'put' && msg.path === '/') fbInbox.heartbeat = msg.data && typeof msg.data === 'object' ? { ...msg.data } : null;
      else if ((type === 'put' || type === 'patch') && msg.path === '/ts') fbInbox.heartbeat = { ...(fbInbox.heartbeat || {}), ts: msg.data };
      else if (type === 'patch' && msg.path === '/') fbInbox.heartbeat = { ...(fbInbox.heartbeat || {}), ...(msg.data || {}) };
      else return;
      sendInboxStatus();
    },
    onClose: () => { /* สตรีมหลักเป็นคนตัดสิน reconnect อยู่แล้ว */ }
  });
  fbInbox.hbStream = hbStream;
  hbStream.start();

  if (Date.now() - fbInbox.lastCleanupAt > FB_CLEANUP_EVERY_MS) setTimeout(fbCleanup, 60 * 1000);
}

// ลบ events ที่เก่ากว่า 2 วัน (ต้องมี ".indexOn": ["ts"] ในกฎ ไม่งั้น Firebase ตอบ 400)
async function fbCleanup() {
  if (!fbConfigured() || fbInbox.state !== 'ok') return;
  fbInbox.lastCleanupAt = Date.now();
  try {
    const cutoff = Date.now() - FB_RETENTION_MS;
    const url = fbBase() + '/events.json?orderBy=' + encodeURIComponent('"ts"') + '&endAt=' + cutoff;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('http ' + res.status + (res.status === 400 ? ' (ยังไม่ได้ใส่ .indexOn ts ในกฎ?)' : ''));
    const data = await res.json();
    const ids = data && typeof data === 'object' ? Object.keys(data) : [];
    if (!ids.length) return;
    const patch = {};
    ids.forEach(id => { patch[id] = null; });
    const del = await fetch(fbBase() + '/events.json', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(20000)
    });
    if (!del.ok) throw new Error('http ' + del.status);
    inboxLog(`☁️ ล้างแจ้งเตือนเก่ากว่า 2 วันใน Firebase ${ids.length} รายการ`, 'i');
  } catch (e) {
    inboxLog('☁️ ล้างข้อมูลเก่าใน Firebase ไม่สำเร็จ: ' + e.message, 'w');
  }
}
setInterval(() => {
  if (Date.now() - fbInbox.lastCleanupAt > FB_CLEANUP_EVERY_MS) fbCleanup();
}, 60 * 60 * 1000).unref();

// watchdog: ไม่มี keep-alive/ข้อมูลใดๆ เกิน 45 วิ = สตรีมค้างเงียบๆ → ตัดแล้วต่อใหม่
setInterval(() => {
  if ((fbInbox.state === 'ok' || fbInbox.state === 'connecting') && fbConfigured() &&
      Date.now() - fbInbox.lastActivity > FB_WATCHDOG_MS) {
    inboxLog('☁️ ไม่มีสัญญาณจาก Firebase เกิน 45 วิ → ต่อใหม่', 'w');
    fbConnect();
  }
}, 5000).unref();

networkChangeHooks.push(() => {
  if (!fbConfigured()) return;
  fbInbox.backoffIdx = 0;
  fbConnect();
});

ipcMain.on('inbox:ack', (_event, { key } = {}) => {
  if (typeof key === 'string' && key > inboxConfig.lastKey) inboxConfig.lastKey = key;
});

// ------------------------------------------
// สถานะรวมส่งให้ renderer (ไฟ LED / tooltip)
// ------------------------------------------
function sendInboxStatus() {
  sendInbox('inbox:status', {
    fb: {
      enabled: fbConfigured(),
      state: fbInbox.state,
      heartbeatTs: fbInbox.heartbeat && typeof fbInbox.heartbeat.ts === 'number' ? fbInbox.heartbeat.ts : 0,
      battery: fbInbox.heartbeat ? fbInbox.heartbeat.battery : undefined,
      lastError: fbInbox.state === 'err' ? fbInbox.lastError : ''
    },
    lan: lanStatusSnapshot()
  });
}
setInterval(sendInboxStatus, 10000).unref();

ipcMain.on('inbox:config', (_event, cfg = {}) => {
  const prev = inboxConfig;
  const port = parseInt(cfg.lanPort, 10);
  inboxConfig = {
    dbUrl: String(cfg.dbUrl || '').trim(),
    inboxKey: String(cfg.inboxKey || '').trim(),
    fbEnabled: !!cfg.fbEnabled,
    lastKey: typeof cfg.lastKey === 'string' && cfg.lastKey > prev.lastKey ? cfg.lastKey : prev.lastKey,
    lanEnabled: !!cfg.lanEnabled,
    lanPort: port > 0 && port < 65536 ? port : 47800
  };
  // renderer เพิ่งโหลด/ตั้งค่าใหม่ — ส่งของค้างที่ยังไม่ ack ให้อีกรอบได้ (renderer กันซ้ำด้วย eventId เอง)
  fbInbox.delivered.clear();
  if (prev.dbUrl !== inboxConfig.dbUrl || prev.inboxKey !== inboxConfig.inboxKey) inboxConfig.lastKey = String(cfg.lastKey || '');
  fbInbox.backoffIdx = 0;
  fbConnect();
  lanRestart();
  sendInboxStatus();
});

// ------------------------------------------
// LanInbox — ช่องทางสำรอง: UDP broadcast ในวงเน็ตเดียวกัน (ไม่ต้องมีอินเทอร์เน็ต)
// ------------------------------------------
// MacroDroid ยิง JSON ไปที่ 255.255.255.255:<port>:
//   {"k":"<INBOX_KEY 8 ตัวแรก>","eventId":"...","title":"...","text":"...","app":"...","ts":<ms>}
//   heartbeat: {"k":"...","hb":1,"battery":<0-100>}
// k ไม่ตรง → ทิ้งเงียบ (อาจเป็นร้านข้างๆ ที่ใช้พอร์ตเดียวกัน), JSON พัง → เตือนใน log ไม่เกินนาทีละครั้ง
const LAN_MAX_PACKET = 8 * 1024;
const lanInbox = {
  socket: null,
  bound: false,
  error: '',
  lastPacketAt: 0,
  heartbeat: null,     // { at, battery }
  lastWarnAt: 0
};

function lanWarn(msg) {
  if (Date.now() - lanInbox.lastWarnAt < 60 * 1000) return;
  lanInbox.lastWarnAt = Date.now();
  inboxLog('📶 ' + msg, 'w');
}

function lanStop() {
  const sock = lanInbox.socket;
  lanInbox.socket = null;
  lanInbox.bound = false;
  if (sock) { try { sock.close(); } catch (e) { /* ปิดไปแล้ว */ } }
}

function lanHandlePacket(msg, rinfo) {
  if (msg.length > LAN_MAX_PACKET) { lanWarn(`packet ใหญ่เกินจาก ${rinfo.address} — ทิ้ง`); return; }
  let data;
  try { data = JSON.parse(msg.toString('utf8')); } catch (e) { data = null; }
  if (!data || typeof data !== 'object') {
    lanWarn(`ได้รับ packet ที่อ่านไม่ได้ (JSON พัง) จาก ${rinfo.address} — ตรวจการ escape ข้อความใน MacroDroid`);
    return;
  }
  if (String(data.k || '') !== inboxConfig.inboxKey.slice(0, 8)) return;

  lanInbox.lastPacketAt = Date.now();
  if (data.hb) {
    lanInbox.heartbeat = { at: Date.now(), battery: data.battery };
    sendInboxStatus();
    return;
  }
  if (typeof data.text !== 'string' || !data.eventId) {
    lanWarn(`packet จาก ${rinfo.address} ข้อมูลไม่ครบ (ต้องมี eventId และ text)`);
    return;
  }
  sendInbox('inbox:event', {
    channel: 'lan',
    id: null,
    eventId: String(data.eventId),
    title: String(data.title || ''),
    body: data.text,
    app: String(data.app || ''),
    // MacroDroid [system_time] เป็นวินาที — แปลงเป็น ms ให้เทียบเวลากับช่องทางอื่นได้
    ts: normalizeEventTs(data.ts)
  });
  sendInboxStatus();
}

function normalizeEventTs(raw) {
  let ts = Number(raw);
  if (!(ts > 0)) return Date.now();
  if (ts < 1e11) ts *= 1000;
  return ts;
}

function lanRestart() {
  lanStop();
  lanInbox.error = '';
  if (!inboxConfig.lanEnabled) { sendInboxStatus(); return; }
  if (!INBOX_KEY_RE.test(inboxConfig.inboxKey)) {
    lanInbox.error = 'ยังไม่มี Inbox Key';
    sendInboxStatus();
    return;
  }
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  lanInbox.socket = sock;
  sock.on('error', (err) => {
    if (lanInbox.socket !== sock) return;
    lanInbox.error = err.code === 'EADDRINUSE' ? `พอร์ต ${inboxConfig.lanPort} ถูกใช้อยู่` : err.message;
    inboxLog('📶 วงเน็ต: เปิดรับไม่ได้ — ' + lanInbox.error, 'e');
    lanStop();
    sendInboxStatus();
  });
  sock.on('message', (msg, rinfo) => {
    if (lanInbox.socket === sock) lanHandlePacket(msg, rinfo);
  });
  sock.bind(inboxConfig.lanPort, '0.0.0.0', () => {
    if (lanInbox.socket !== sock) return;
    lanInbox.bound = true;
    try { sock.setBroadcast(true); } catch (e) { /* ไม่จำเป็นต่อการรับ */ }
    sendInboxStatus();
  });
}

function lanStatusSnapshot() {
  return {
    enabled: inboxConfig.lanEnabled,
    bound: lanInbox.bound,
    port: inboxConfig.lanPort,
    error: lanInbox.error,
    lastPacketAt: lanInbox.lastPacketAt,
    heartbeatAt: lanInbox.heartbeat ? lanInbox.heartbeat.at : 0,
    battery: lanInbox.heartbeat ? lanInbox.heartbeat.battery : undefined,
    ips: getLanIPs()
  };
}

// เปลี่ยนการ์ด/IP (Wi-Fi ร้าน ↔ ฮอตสปอต) → close + bind ใหม่ ให้ได้ยิน broadcast ของวงใหม่
networkChangeHooks.push(() => {
  if (inboxConfig.lanEnabled) lanRestart();
});

// ------------------------------------------
// Windows Firewall — ฮอตสปอตใหม่มักถูกจัดเป็นเครือข่าย "Public" แต่กฎ allow ที่ Windows ถาม
// ตอนเปิดแอปครั้งแรกมักครอบแค่ Private → UDP ถูกบล็อกเงียบๆ จึงเพิ่มกฎเองแบบ -Profile Any
// ------------------------------------------
const FIREWALL_RULE_NAME = 'POS Hero LAN Inbox';

function runPowerShell(command, timeout) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: timeout || 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
}

ipcMain.handle('inbox:firewall-check', async () => {
  const r = await runPowerShell(
    `$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue; ` +
    `if ($r) { ($r | Get-NetFirewallPortFilter | Select-Object -ExpandProperty LocalPort) -join ',' } else { 'NONE' }`);
  if (!r.ok) return { ok: false, reason: r.stderr.trim() };
  const out = r.stdout.trim();
  if (out === 'NONE' || out === '') return { ok: true, exists: false, ports: [] };
  return { ok: true, exists: true, ports: out.split(',').map(s => s.trim()).filter(Boolean) };
});

ipcMain.handle('inbox:firewall-add', async (_event, rawPort) => {
  const port = parseInt(rawPort, 10);
  if (!(port > 0 && port < 65536)) return { ok: false, reason: 'พอร์ตไม่ถูกต้อง' };
  // คำสั่งที่รันด้วยสิทธิ์ admin ส่งแบบ -EncodedCommand กันปัญหา quote ซ้อนหลายชั้น
  const inner =
    `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue; ` +
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Protocol UDP -LocalPort ${port} -Action Allow -Profile Any | Out-Null`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const r = await runPowerShell(
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
    120000);
  if (!r.ok) return { ok: false, reason: /cancel/i.test(r.stderr) ? 'ยกเลิกการขอสิทธิ์ admin' : r.stderr.trim() };
  return { ok: true };
});
