// Smoke test ของระบบกระเป๋าสินค้า เทียบกับ Worker ที่รันอยู่ (ค่าเริ่มต้น: wrangler dev ที่ http://127.0.0.1:8787)
//   BASE=https://pos-hero-inbox.<you>.workers.dev node test/catalog-smoke.js
// ใช้ Catalog Key สุ่มของตัวเอง ไม่ปนข้อมูลร้าน
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = 'SmokeCat' + Math.random().toString(36).slice(2).padEnd(32, 'x');
const root = `${BASE}/catalog/${KEY}`;
const TOKEN = 'tok-' + Math.random().toString(36).slice(2).padEnd(24, 'y');
let failed = 0;
// อ่าน body ของทุกคำตอบจนจบ ไม่งั้นการเชื่อมต่อที่ใช้ซ้ำของ undici จะค้างคำตอบเก่า
const realFetch = fetch;
const fetch2 = async (...a) => { const r = await realFetch(...a); const buf = await r.arrayBuffer(); return new Response(r.status === 304 ? null : buf, { status: r.status, headers: r.headers }); };
const check = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  → ' + JSON.stringify(detail))); };

const get = async (path) => { const r = await fetch2(root + path); return { status: r.status, body: await r.json().catch(() => null) }; };
const send = async (method, path, body, token = TOKEN) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['X-Catalog-Write'] = token;
  const r = await fetch2(root + path, { method, headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const item = (id, at, by, extra) => ({ id, code: '00' + id.slice(-3), name: 'สินค้า ' + id, cat: 'ทั่วไป', fav: false, image: null, updatedAt: at, updatedBy: by, deleted: false, ...extra });
const hashHex = (c) => c.repeat(64);

(async () => {
  const t0 = Date.now();

  // ---- ก่อน init ----
  check('bad key rejected', (await fetch2(`${BASE}/catalog/short/health`)).status === 401);
  check('health before init', (await get('/health')).body.initialized === false);
  check('write before init → 401 not-initialized', (await send('POST', '/items', { items: [item('a001', t0, 'dev-a')] })).body.error === 'not-initialized');
  check('init rejects short token', (await send('POST', '/init', { writeToken: 'short' }, null)).status === 400);

  // ---- init ----
  const init = await send('POST', '/init', { writeToken: TOKEN }, null);
  check('init ok', init.status === 200 && init.body.ok, init);
  check('init twice → 409', (await send('POST', '/init', { writeToken: TOKEN + 'z' }, null)).status === 409);
  check('health after init', (await get('/health')).body.initialized === true);

  // ---- สิทธิ์เขียน ----
  const noTok = await send('POST', '/items', { items: [item('a001', t0, 'dev-a')] }, null);
  check('no write token → 401', noTok.status === 401 && noTok.body.error === 'bad-write-token', noTok);
  check('wrong write token → 401', (await send('POST', '/items', { items: [item('a001', t0, 'dev-a')] }, 'wrong-' + TOKEN)).status === 401);
  check('meta without token → 401', (await send('PUT', '/meta', { categories: [], updatedAt: t0, updatedBy: 'dev-a' }, null)).status === 401);
  check('image without token → 401', (await fetch2(`${root}/img/${hashHex('a')}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(20) })).status === 401);
  check('reads need no token', (await get('/changes?since=0')).status === 200);

  // ---- push 3 ชิ้น + changes ----
  const push = await send('POST', '/items', { items: [item('a001', t0, 'dev-a'), item('a002', t0 + 1, 'dev-a'), item('a003', t0 + 2, 'dev-a', { fav: true })] });
  check('push 3 items accepted', push.status === 200 && push.body.accepted.length === 3 && push.body.rejected.length === 0, push);
  check('revs strictly increase', push.body.accepted.map(a => a.rev).join() === '1,2,3', push.body.accepted);
  const ch0 = await get('/changes?since=0');
  check('changes since 0 returns all 3', ch0.body.items.length === 3 && ch0.body.rev === 3 && ch0.body.more === false, ch0.body);
  check('stored item keeps fields and gets rev', ch0.body.items[2].fav === true && ch0.body.items[2].rev === 3 && ch0.body.items[0].code === '00001', ch0.body.items);
  const ch2 = await get('/changes?since=2');
  check('changes since 2 returns only a003', ch2.body.items.length === 1 && ch2.body.items[0].id === 'a003', ch2.body);
  check('health counts items', (await get('/health')).body.itemCount === 3);
  check('resend identical write is idempotent (rev unchanged)', (await send('POST', '/items', { items: [item('a001', t0, 'dev-a')] })).body.accepted[0].rev === 1);
  const page = await get('/changes?since=0&limit=2');
  check('limit/more pagination', page.body.items.length === 2 && page.body.more === true && page.body.rev === 2, page.body);

  // ---- แก้ชนกันจาก 2 deviceId ----
  const win = await send('POST', '/items', { items: [item('a001', t0 + 5000, 'dev-b', { name: 'แก้จาก B' })] });
  check('newer edit from dev-b accepted', win.body.accepted.length === 1 && win.body.accepted[0].rev === 4, win.body);
  const lose = await send('POST', '/items', { items: [item('a001', t0 + 3000, 'dev-a', { name: 'แก้จาก A (เก่ากว่า)' })] });
  check('older edit from dev-a rejected stale with current', lose.body.rejected.length === 1 && lose.body.rejected[0].reason === 'stale' && lose.body.rejected[0].current.name === 'แก้จาก B', lose.body);
  const tieLow = await send('POST', '/items', { items: [item('a001', t0 + 5000, 'dev-a', { name: 'เสมอ A' })] });
  check('same updatedAt: smaller updatedBy loses', tieLow.body.rejected.length === 1, tieLow.body);
  const tieHigh = await send('POST', '/items', { items: [item('a001', t0 + 5000, 'dev-c', { name: 'เสมอ C' })] });
  check('same updatedAt: larger updatedBy wins', tieHigh.body.accepted.length === 1, tieHigh.body);
  check('winner is what changes returns', (await get('/changes?since=4')).body.items[0].name === 'เสมอ C');

  // ---- tombstone ----
  const del = await send('POST', '/items', { items: [item('a002', t0 + 6000, 'dev-a', { deleted: true })] });
  check('tombstone accepted', del.body.accepted.length === 1, del.body);
  const chd = await get('/changes?since=0');
  check('tombstone shows in changes with deleted:true', chd.body.items.find(i => i.id === 'a002').deleted === true, chd.body);
  check('health excludes deleted', (await get('/health')).body.itemCount === 2);
  const stale = await send('POST', '/items', { items: [item('a002', t0 + 4000, 'dev-b', { name: 'ฟื้นด้วยของเก่า' })] });
  check('older edit cannot resurrect deleted item', stale.body.rejected.length === 1 && stale.body.rejected[0].reason === 'stale', stale.body);
  const revive = await send('POST', '/items', { items: [item('a002', t0 + 9000, 'dev-b', { name: 'ฟื้นจริง' })] });
  check('newer edit revives deleted item', revive.body.accepted.length === 1 && (await get('/changes?since=0')).body.items.find(i => i.id === 'a002').deleted === false, revive.body);

  // ---- validation / นาฬิกาเพี้ยน ----
  const skew = await send('POST', '/items', { items: [item('a004', Date.now() + 11 * 60 * 1000, 'dev-a')] });
  check('clock >10min ahead → 409 with serverTime', skew.status === 409 && skew.body.error === 'clock-skew' && Math.abs(skew.body.serverTime - Date.now()) < 5000, skew);
  check('skew request applied nothing', (await get('/health')).body.itemCount === 3);
  const mixed = await send('POST', '/items', { items: [{ id: 'bad id!', updatedAt: t0, updatedBy: 'dev-a' }, item('a005', t0, 'dev-a')] });
  check('invalid item rejected, valid one still accepted', mixed.body.rejected.length === 1 && mixed.body.rejected[0].reason === 'bad-id' && mixed.body.accepted.length === 1, mixed.body);
  check('201 items rejected', (await send('POST', '/items', { items: Array.from({ length: 201 }, (_, i) => item('x' + i, t0, 'dev-a')) })).status === 400);
  check('since ahead of server → resetRequired', (await get('/changes?since=99999')).body.resetRequired === true);
  check('bad since → 400', (await get('/changes?since=abc')).status === 400);

  // ---- meta ----
  const m1 = await send('PUT', '/meta', { categories: ['ขนม', 'น้ำ'], shopName: 'ร้านทดสอบ', updatedAt: t0 + 100, updatedBy: 'dev-a' });
  check('meta accepted', m1.body.accepted === true, m1);
  const mch = await get('/changes?since=0');
  check('meta in changes, ทั่วไป added, rev from shared counter', mch.body.meta && mch.body.meta.categories[0] === 'ทั่วไป' && mch.body.meta.categories.includes('น้ำ') && mch.body.meta.shopName === 'ร้านทดสอบ' && mch.body.meta.rev === m1.body.rev, mch.body.meta);
  const m2 = await send('PUT', '/meta', { categories: ['เก่า'], shopName: 'x', updatedAt: t0 + 50, updatedBy: 'dev-b' });
  check('older meta rejected as stale', m2.body.accepted === false && m2.body.reason === 'stale', m2.body);
  check('meta not repeated when since is past it', (await get('/changes?since=' + m1.body.rev)).body.meta === undefined);

  // ---- รูป ----
  const jpeg = new Uint8Array(2048);
  jpeg.set([0xFF, 0xD8, 0xFF, 0xE0]);
  for (let i = 4; i < jpeg.length - 2; i++) jpeg[i] = (i * 7) & 0xFF;
  jpeg.set([0xFF, 0xD9], jpeg.length - 2);
  const h = hashHex('c');
  const put = (variant, body, type = 'image/jpeg') => fetch2(`${root}/img/${h}/${variant}`, { method: 'PUT', headers: { 'Content-Type': type, 'X-Catalog-Write': TOKEN }, body });
  const up = await put('thumb-v1', jpeg);
  check('upload image 201', up.status === 201, await up.clone().text());
  const dl = await fetch2(`${root}/img/${h}/thumb-v1`);
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  check('download returns same bytes', dl.status === 200 && dlBytes.length === jpeg.length && dlBytes.every((b, i) => b === jpeg[i]));
  check('immutable cache headers', /immutable/.test(dl.headers.get('Cache-Control')) && /max-age=31536000/.test(dl.headers.get('Cache-Control')) && dl.headers.get('Content-Type') === 'image/jpeg', Object.fromEntries(dl.headers));
  const dl304 = await fetch2(`${root}/img/${h}/thumb-v1`, { headers: { 'If-None-Match': dl.headers.get('ETag') } });
  check('If-None-Match → 304', dl304.status === 304);
  const again = await put('thumb-v1', jpeg);
  check('re-upload same name is a no-op success', again.status === 200 && (await again.json()).existed === true);
  check('other variant not found yet', (await fetch2(`${root}/img/${h}/full`)).status === 404);
  check('bad type → 415', (await put('full', jpeg, 'image/png')).status === 415);
  const junk = await put('full', new Uint8Array(64).fill(1));
  check('non-image bytes → 400', junk.status === 400, [junk.status, await junk.text()]);
  check('bad variant → 400', (await put('huge', jpeg)).status === 400);
  check('over 5MB → 413', (await put('orig', new Uint8Array(5 * 1024 * 1024 + 1024).fill(0xFF))).status === 413);
  const otherKey = await fetch2(`${BASE}/catalog/${KEY.replace(/.$/, 'Q')}/img/${h}/thumb-v1`);
  check('image is not visible under a different key', otherKey.status === 404);

  // ---- export + แยก key ----
  const exp = await fetch2(root + '/export');
  const expBody = await exp.json();
  check('export has meta + live items, attachment header', exp.status === 200 && expBody.items.length === 4 && expBody.meta.shopName === 'ร้านทดสอบ' && /attachment/.test(exp.headers.get('Content-Disposition')), expBody.items && expBody.items.length);
  const other = await (await fetch2(`${BASE}/catalog/${KEY.replace(/.$/, 'Q')}/changes?since=0`)).json();
  check('different key sees nothing', other.items.length === 0 && other.rev === 0, other);

  // ---- CORS + inbox เดิมไม่กระทบ ----
  const pre = await fetch2(root + '/items', { method: 'OPTIONS' });
  check('CORS preflight allows X-Catalog-Write', pre.status === 200 && /X-Catalog-Write/.test(pre.headers.get('Access-Control-Allow-Headers')));
  check('inbox health still works', (await fetch2(BASE + '/health')).ok);
  check('unknown path under /catalog → 404', (await get('/nope')).status === 404);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
