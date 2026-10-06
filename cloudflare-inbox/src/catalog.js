// กระเป๋าสินค้า (Catalog Hero) บน Worker ตัวเดียวกับ inbox
//
//   GET  /catalog/{key}/health                 {ok, rev, itemCount, serverTime, initialized}
//   POST /catalog/{key}/init                   {writeToken} ตั้งรหัสเขียนครั้งแรก (ตั้งแล้วตอบ 409)
//   GET  /catalog/{key}/changes?since=&limit=  ส่งเฉพาะที่ rev > since
//   POST /catalog/{key}/items                  {items:[...]} ≤ 200 ชิ้น รวมด้วย mergeItem ทีละชิ้น
//   PUT  /catalog/{key}/meta                   {categories, shopName, updatedAt, updatedBy}
//   PUT  /catalog/{key}/img/{hash}/{variant}   อัปโหลดรูป (variant = orig|full|thumb ต่อท้าย -v{n} ได้)
//   GET  /catalog/{key}/img/{hash}/{variant}   ดึงรูป (immutable)
//   GET  /catalog/{key}/export                 สำรองทั้ง catalog เป็น JSON (ไม่รวมรูป)
//
// key = Catalog Key ยาว 32–128 ตัว ใครมี key อ่านได้ ส่วนการเขียนต้องมี header X-Catalog-Write
// รหัสเขียนเก็บเป็นแฮช SHA-256 ใน Durable Object เท่านั้น ข้อความ error เป็นภาษาไทยและบอกว่าควรทำอะไรต่อ

import { compareItems, isTooFarInFuture, normalizeCategories, DEFAULT_CATEGORY } from '../../catalog/shared/merge.js';

const CATALOG_PATH_RE = /^\/catalog\/([A-Za-z0-9_-]{32,128})(\/.*)?$/;
const IMG_PATH_RE = /^\/img\/([a-f0-9]{64})\/([a-z0-9-]+)$/;
const VARIANT_RE = /^(orig|full|thumb)(-v[0-9]{1,6})?$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_ITEMS_PER_POST = 200;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ITEM_JSON = 64 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_CHANGES_LIMIT = 1000;
const DEFAULT_CHANGES_LIMIT = 500;
const TOMBSTONE_DAYS = 90;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const IMAGE_TYPES = ['image/jpeg', 'image/webp'];

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200, extra) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra }
});
const err = (status, code, message, extra) => json({ error: code, message, ...extra }, status);

async function sha256Hex(input) {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function looksLikeImage(bytes, type) {
  if (type === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  // WebP = "RIFF" .... "WEBP"
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

// ด่านหน้า (ก่อนถึง Durable Object): preflight, key ผิดรูป, ดึงรูปจาก R2 ตรงๆ ไม่ต้องผ่าน DO
export async function routeCatalog(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Catalog-Write',
      'Access-Control-Max-Age': '86400'
    } });
  }
  const m = url.pathname.match(CATALOG_PATH_RE);
  if (!m) return err(401, 'bad-key', 'Catalog Key ต้องยาว 32–128 ตัว ใช้ได้แค่ A-Z a-z 0-9 _ - ตรวจค่าในหน้าตั้งค่า Cloudflare');
  const img = (m[2] || '').match(IMG_PATH_RE);
  if (img && (request.method === 'GET' || request.method === 'HEAD')) return getImage(request, env, m[1], img[1], img[2]);
  // รูปใหญ่เกินกำหนดปฏิเสธตั้งแต่ด่านหน้า ไม่ส่ง body ก้อนใหญ่ต่อไปให้ DO
  if (img && request.method === 'PUT' && Number(request.headers.get('Content-Length')) > MAX_IMAGE) {
    return err(413, 'image-too-large', 'รูปใหญ่เกิน 5MB ย่อรูปหรือลดคุณภาพแล้วลองใหม่');
  }
  return env.CATALOG.get(env.CATALOG.idFromName(m[1])).fetch(request);
}

async function getImage(request, env, key, hash, variant) {
  if (!VARIANT_RE.test(variant)) return err(404, 'no-image', 'ไม่พบรูปนี้ ลองกดซิงก์ใหม่');
  const obj = await env.CATALOG_IMAGES.get(`${await sha256Hex(key)}/${hash}/${variant}`);
  if (!obj) return err(404, 'no-image', 'ไม่พบรูปนี้บนเซิร์ฟเวอร์ รูปอาจยังอัปโหลดไม่เสร็จ ลองกดซิงก์อีกครั้ง');
  const headers = {
    ...CORS,
    'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': obj.httpEtag
  };
  if (request.headers.get('If-None-Match') === obj.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

export class Catalog {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, rev INTEGER, updated_at INTEGER, updated_by TEXT, deleted INTEGER, data TEXT, srv_ts INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS items_rev ON items(rev)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }

  kvGet(k) {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }
  kvSet(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, String(v)); }
  currentRev() { return Number(this.kvGet('rev')) || 0; }
  nextRev() { const r = this.currentRev() + 1; this.kvSet('rev', r); return r; }

  getMeta() {
    const raw = this.kvGet('meta');
    return raw ? JSON.parse(raw) : { categories: [DEFAULT_CATEGORY], shopName: '', schemaVersion: 1, updatedAt: 0, updatedBy: '', rev: 0 };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const sub = url.pathname.match(CATALOG_PATH_RE)[2] || '/';
    const method = request.method;
    try {
      this.cleanup(Date.now());
      if (sub === '/health' && method === 'GET') return this.health();
      if (sub === '/init' && method === 'POST') return await this.init(request);
      if (sub === '/changes' && method === 'GET') return this.changes(url);
      if (sub === '/export' && method === 'GET') return this.exportAll(url);
      if (sub === '/items' && method === 'POST') return await this.guarded(request, () => this.postItems(request));
      if (sub === '/meta' && method === 'PUT') return await this.guarded(request, () => this.putMeta(request));
      const img = sub.match(IMG_PATH_RE);
      if (img && method === 'PUT') return await this.guarded(request, () => this.putImage(request, url, img[1], img[2]));
      const known = ['/health', '/init', '/changes', '/export', '/items', '/meta'].includes(sub) || img;
      if (known) return err(405, 'bad-method', 'คำสั่งนี้ใช้วิธีส่ง (method) ไม่ถูกต้อง อัปเดตแอปให้เป็นเวอร์ชันล่าสุด');
      return err(404, 'not-found', 'ไม่พบปลายทางนี้ ตรวจ Worker URL ว่าเป็นตัวที่มีระบบกระเป๋าสินค้า (deploy ใหม่ล่าสุดแล้ว)');
    } catch (e) {
      console.log('[catalog]', e && e.stack || e);
      return err(500, 'server-error', 'เซิร์ฟเวอร์ขัดข้องชั่วคราว ไม่มีข้อมูลหาย รายการจะถูกส่งใหม่เองภายหลัง');
    }
  }

  // ---- auth ----
  async guarded(request, handler) {
    const stored = this.kvGet('writeTokenHash');
    if (!stored) return err(401, 'not-initialized', 'กระเป๋านี้ยังไม่ได้ตั้งรหัสเขียน ไปที่ ตั้งค่า Cloudflare แล้วกด "ตั้งรหัสเขียน" ก่อน');
    const given = request.headers.get('X-Catalog-Write') || '';
    if (!given || !safeEqual(await sha256Hex(given), stored)) {
      return err(401, 'bad-write-token', 'รหัสเขียนไม่ถูกต้อง เครื่องนี้ดูได้อย่างเดียว ถ้าต้องการแก้ ให้ใส่ Write token ที่ตั้งไว้ในหน้าตั้งค่า Cloudflare');
    }
    return handler();
  }

  async readJson(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    return JSON.parse(text);
  }
  async readJsonOrError(request) {
    try { return { body: await this.readJson(request) }; } catch (e) {
      if (e && e.status === 413) return { res: err(413, 'too-large', 'ข้อมูลที่ส่งใหญ่เกินไป ลดจำนวนสินค้าต่อครั้งแล้วส่งใหม่') };
      return { res: err(400, 'bad-json', 'ข้อมูลที่ส่งมาอ่านไม่ได้ อัปเดตแอปให้เป็นเวอร์ชันล่าสุดแล้วลองใหม่') };
    }
  }

  // ---- endpoints ----
  health() {
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM items WHERE deleted = 0').one().n;
    return json({ ok: true, rev: this.currentRev(), itemCount: n, serverTime: Date.now(), initialized: !!this.kvGet('writeTokenHash') });
  }

  async init(request) {
    if (this.kvGet('writeTokenHash')) return err(409, 'already-initialized', 'กระเป๋านี้ตั้งรหัสเขียนไปแล้ว ใช้ Write token เดิม ถ้าลืมให้สร้าง Catalog Key ใหม่');
    const { body, res } = await this.readJsonOrError(request);
    if (res) return res;
    const token = body && body.writeToken;
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      return err(400, 'bad-write-token', 'Write token ต้องยาว 16–128 ตัวอักษร ให้แอปสุ่มให้ด้วยปุ่ม "สุ่มรหัส"');
    }
    this.kvSet('writeTokenHash', await sha256Hex(token));
    return json({ ok: true, serverTime: Date.now() });
  }

  changes(url) {
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Number(url.searchParams.get('limit') || DEFAULT_CHANGES_LIMIT);
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) {
      return err(400, 'bad-query', 'พารามิเตอร์ since/limit ไม่ถูกต้อง อัปเดตแอปให้เป็นเวอร์ชันล่าสุด');
    }
    const rev = this.currentRev();
    const horizon = Number(this.kvGet('tombstoneHorizonRev')) || 0;
    // เครื่องที่ since เก่ากว่าที่ล้างรายการลบไปแล้ว หรือล้ำหน้า server (server ถูกรีเซ็ต) ต้องดึงใหม่ทั้งหมด
    if ((since > 0 && since < horizon) || since > rev) {
      return json({ resetRequired: true, rev, serverTime: Date.now() });
    }
    const cap = Math.min(limit, MAX_CHANGES_LIMIT);
    const rows = this.sql.exec('SELECT data FROM items WHERE rev > ? ORDER BY rev LIMIT ?', since, cap + 1).toArray();
    const more = rows.length > cap;
    const items = rows.slice(0, cap).map(r => JSON.parse(r.data));
    const outRev = more ? items[items.length - 1].rev : rev;
    const out = { items, rev: outRev, more, serverTime: Date.now() };
    const meta = this.getMeta();
    if (meta.rev > since && meta.rev <= outRev) out.meta = meta;
    return json(out);
  }

  async postItems(request) {
    const { body, res } = await this.readJsonOrError(request);
    if (res) return res;
    const list = body && body.items;
    if (!Array.isArray(list) || !list.length) return err(400, 'bad-items', 'ไม่มีรายการสินค้าที่จะส่ง');
    if (list.length > MAX_ITEMS_PER_POST) return err(400, 'too-many-items', `ส่งได้สูงสุด ${MAX_ITEMS_PER_POST} ชิ้นต่อครั้ง แอปจะแบ่งส่งให้เอง อัปเดตแอปให้เป็นเวอร์ชันล่าสุด`);
    const now = Date.now();
    const bad = list.find(it => it && typeof it === 'object' && isTooFarInFuture(it.updatedAt, now));
    if (bad) return clockSkew(now);

    const accepted = [];
    const rejected = [];
    for (const it of list) {
      const problem = validateItem(it);
      if (problem) { rejected.push({ id: it && typeof it.id === 'string' ? it.id : null, reason: problem }); continue; }
      const row = this.sql.exec('SELECT data FROM items WHERE id = ?', it.id).toArray()[0];
      const existing = row ? JSON.parse(row.data) : null;
      const c = compareItems(it, existing);
      if (c < 0) { rejected.push({ id: it.id, reason: 'stale', current: existing }); continue; }
      if (c === 0) { accepted.push({ id: it.id, rev: existing.rev }); continue; } // ส่งซ้ำ ไม่ต้องเพิ่ม rev
      const rev = this.nextRev();
      const stored = { ...it, deleted: !!it.deleted, rev };
      this.sql.exec('INSERT OR REPLACE INTO items (id, rev, updated_at, updated_by, deleted, data, srv_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
        it.id, rev, it.updatedAt, it.updatedBy, stored.deleted ? 1 : 0, JSON.stringify(stored), now);
      accepted.push({ id: it.id, rev });
    }
    return json({ accepted, rejected, serverTime: now });
  }

  async putMeta(request) {
    const { body, res } = await this.readJsonOrError(request);
    if (res) return res;
    const now = Date.now();
    if (!body || typeof body !== 'object' || !Array.isArray(body.categories) ||
        body.categories.length > 200 || body.categories.some(c => typeof c !== 'string' || c.length > 60) ||
        (body.shopName != null && (typeof body.shopName !== 'string' || body.shopName.length > 120)) ||
        !Number.isFinite(body.updatedAt) || body.updatedAt <= 0 ||
        typeof body.updatedBy !== 'string' || !body.updatedBy || body.updatedBy.length > 64) {
      return err(400, 'bad-meta', 'ข้อมูลหมวดหมู่/ชื่อร้านไม่ถูกต้อง ตรวจชื่อหมวดว่าไม่ยาวเกิน 60 ตัว');
    }
    if (isTooFarInFuture(body.updatedAt, now)) return clockSkew(now);
    const current = this.getMeta();
    const c = compareItems(body, current.updatedAt ? current : null);
    if (c < 0) return json({ accepted: false, reason: 'stale', current, serverTime: now });
    if (c === 0) return json({ accepted: true, rev: current.rev, serverTime: now });
    const meta = {
      categories: normalizeCategories(body.categories),
      shopName: body.shopName || '',
      schemaVersion: 1,
      updatedAt: body.updatedAt,
      updatedBy: body.updatedBy,
      rev: this.nextRev()
    };
    this.kvSet('meta', JSON.stringify(meta));
    return json({ accepted: true, rev: meta.rev, serverTime: now });
  }

  async putImage(request, url, hash, variant) {
    // ตอบ error ก่อนอ่าน body ต้องทิ้ง body ให้เรียบร้อย ไม่งั้นการเชื่อมต่อที่ใช้ซ้ำอาจหลุด
    const reject = async (status, code, message) => { try { await request.body?.cancel(); } catch (e) { /* ignore */ } return err(status, code, message); };
    if (!VARIANT_RE.test(variant)) return reject(400, 'bad-variant', 'ชนิดรูปต้องเป็น orig, full หรือ thumb (ต่อท้าย -v1 ได้) อัปเดตแอปให้เป็นเวอร์ชันล่าสุด');
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) return reject(415, 'bad-image-type', 'รับเฉพาะรูป JPEG หรือ WebP แปลงรูปก่อนอัปโหลด');
    const declared = Number(request.headers.get('Content-Length'));
    if (declared > MAX_IMAGE) return reject(413, 'image-too-large', 'รูปใหญ่เกิน 5MB ย่อรูปหรือลดคุณภาพแล้วลองใหม่');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_IMAGE) return err(413, 'image-too-large', 'รูปใหญ่เกิน 5MB ย่อรูปหรือลดคุณภาพแล้วลองใหม่');
    if (bytes.length < 12 || !looksLikeImage(bytes, type)) return err(400, 'bad-image', 'ไฟล์นี้ไม่ใช่รูปที่อ่านได้ ลองเลือกรูปใหม่');
    const objKey = `${await sha256Hex(url.pathname.match(CATALOG_PATH_RE)[1])}/${hash}/${variant}`;
    // รูปเป็น immutable ฝั่ง cache จึงไม่เขียนทับ ส่งซ้ำ (retry จาก outbox) ถือว่าสำเร็จ
    if (await this.env.CATALOG_IMAGES.head(objKey)) return json({ ok: true, existed: true });
    await this.env.CATALOG_IMAGES.put(objKey, bytes, { httpMetadata: { contentType: type } });
    return json({ ok: true, existed: false, size: bytes.length }, 201);
  }

  exportAll(url) {
    const includeDeleted = url.searchParams.get('deleted') === '1';
    const rows = this.sql.exec(`SELECT data FROM items ${includeDeleted ? '' : 'WHERE deleted = 0'} ORDER BY rev`).toArray();
    const body = { exportedAt: Date.now(), rev: this.currentRev(), meta: this.getMeta(), items: rows.map(r => JSON.parse(r.data)) };
    return json(body, 200, { 'Content-Disposition': 'attachment; filename="catalog-export.json"' });
  }

  // ล้าง tombstone ที่เก่ากว่า 90 วัน (ตั้ง TOMBSTONE_DAYS / CLEANUP_MS ใน env ได้ ไว้ทดสอบ)
  cleanup(now) {
    const every = this.env && this.env.CLEANUP_MS != null ? Number(this.env.CLEANUP_MS) : CLEANUP_EVERY_MS;
    if (now - (Number(this.kvGet('lastCleanup')) || 0) < every) return;
    this.kvSet('lastCleanup', now);
    const days = this.env && this.env.TOMBSTONE_DAYS != null ? Number(this.env.TOMBSTONE_DAYS) : TOMBSTONE_DAYS;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const top = this.sql.exec('SELECT MAX(rev) AS r FROM items WHERE deleted = 1 AND srv_ts < ?', cutoff).one().r;
    if (top == null) return;
    this.kvSet('tombstoneHorizonRev', Math.max(Number(this.kvGet('tombstoneHorizonRev')) || 0, top));
    this.sql.exec('DELETE FROM items WHERE deleted = 1 AND srv_ts < ?', cutoff);
  }
}

function clockSkew(now) {
  return err(409, 'clock-skew', 'นาฬิกาเครื่องนี้เร็วกว่าเซิร์ฟเวอร์เกิน 10 นาที แอปจะปรับเวลาให้แล้วส่งใหม่ ถ้ายังไม่ได้ให้ตั้งเวลาเครื่องใหม่', { serverTime: now });
}

function validateItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return 'not-object';
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) return 'bad-id';
  if (!Number.isFinite(it.updatedAt) || it.updatedAt <= 0) return 'bad-updatedAt';
  if (typeof it.updatedBy !== 'string' || !it.updatedBy || it.updatedBy.length > 64) return 'bad-updatedBy';
  if (it.code != null && typeof it.code !== 'string') return 'bad-code';
  if (JSON.stringify(it).length > MAX_ITEM_JSON) return 'too-large';
  return null;
}
