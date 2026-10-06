// POS Hero inbox บน Cloudflare Workers + Durable Objects
//
// รับ-ส่งแบบเดียวกับส่วนที่ POS Hero ใช้จาก Firebase Realtime Database (REST + SSE) ทุกอย่าง
// → แอปบนคอมและ MacroDroid เปลี่ยนแค่ URL ไม่ต้องแก้โค้ด (ดู main.js ส่วน FirebaseInbox)
//
//   POST  /pos_hero_inbox/{key}/events.json                 เพิ่มแจ้งเตือน → {"name": "<pushId>"}
//   GET   /pos_hero_inbox/{key}/events.json?orderBy="$key"&startAt="<id>"   ดึงรายการตั้งแต่ id นั้น
//   GET   /pos_hero_inbox/{key}/events.json?orderBy="ts"&endAt=<ms>        รายการที่เก่ากว่าเวลานั้น
//   GET   ... + header Accept: text/event-stream            SSE: put "/" ครั้งแรก แล้ว put "/<id>" ทุกรายการใหม่
//   PATCH /pos_hero_inbox/{key}/events.json  {"<id>": null}   ลบรายการ
//   PUT   /pos_hero_inbox/{key}/heartbeat.json               heartbeat ของมือถือ (GET / SSE ได้เหมือนกัน)
//
// {".sv":"timestamp"} ถูกแทนด้วยเวลาของเซิร์ฟเวอร์เหมือน Firebase
// แต่ละ Inbox Key ได้ Durable Object ของตัวเอง (ข้อมูลแยกกันขาด) ต้องยาว ≥ 32 ตัว เหมือนกฎ Firebase เดิม

import { routeCatalog } from './catalog.js';
export { Catalog } from './catalog.js';

const KEY_PATH_RE = /^\/pos_hero_inbox\/([A-Za-z0-9_-]{32,128})\/(events|heartbeat)\.json$/;
const MAX_BODY = 16 * 1024;
const MAX_EVENTS = 5000;                       // กันใครยิงสแปมจนพื้นที่เต็ม
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;  // ลบเองเผื่อแอปไม่ได้เปิดมาล้าง (แอปล้างที่ 2 วันอยู่แล้ว)
const KEEPALIVE_MS = 25 * 1000;                // แอปตัดแล้วต่อใหม่ถ้าเงียบเกิน 45 วิ
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
});
const fbError = (status, msg) => json({ error: msg }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/catalog/')) return routeCatalog(request, env, url); // กระเป๋าสินค้า (src/catalog.js) ต้องมาก่อนเช็ก inbox
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type'
      } });
    }
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, name: 'POS Hero inbox' });
    const m = url.pathname.match(KEY_PATH_RE);
    if (!m) return fbError(401, 'Permission denied');
    const stub = env.INBOX.get(env.INBOX.idFromName(m[1]));
    return stub.fetch(request);
  }
};

function resolveServerValues(v, now) {
  if (v && typeof v === 'object') {
    if (!Array.isArray(v) && v['.sv'] === 'timestamp' && Object.keys(v).length === 1) return now;
    const out = Array.isArray(v) ? [] : {};
    for (const k of Object.keys(v)) out[k] = resolveServerValues(v[k], now);
    return out;
  }
  return v;
}

function parseQueryValue(raw) {
  if (raw == null) return undefined;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

export class Inbox {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts INTEGER, data TEXT)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_ts ON events (ts)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.clients = new Set(); // { kind: 'events'|'heartbeat', writer }
    this.lastPushTime = 0;
    this.lastRandChars = [];
    this.keepAlive = null;
  }

  // push id แบบ Firebase: เวลา 8 ตัว + สุ่ม 12 ตัว เรียงตามเวลาเสมอ (ms เดียวกันก็ยังเรียงถูก)
  nextPushId(now) {
    const dup = now === this.lastPushTime;
    this.lastPushTime = now;
    let t = now;
    let prefix = '';
    for (let i = 0; i < 8; i++) { prefix = PUSH_CHARS.charAt(t % 64) + prefix; t = Math.floor(t / 64); }
    if (!dup) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      this.lastRandChars = Array.from(bytes, b => b % 64);
    } else {
      let i = 11;
      for (; i >= 0 && this.lastRandChars[i] === 63; i--) this.lastRandChars[i] = 0;
      if (i >= 0) this.lastRandChars[i]++;
    }
    return prefix + this.lastRandChars.map(n => PUSH_CHARS.charAt(n)).join('');
  }

  async fetch(request) {
    const url = new URL(request.url);
    const kind = url.pathname.match(KEY_PATH_RE)[2];
    const wantsStream = request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/event-stream');
    this.cleanup();

    if (kind === 'events') {
      if (request.method === 'GET') {
        const snapshot = this.queryEvents(url.searchParams);
        return wantsStream ? this.openStream('events', snapshot) : json(snapshot);
      }
      if (request.method === 'POST') return this.addEvent(request);
      if (request.method === 'PATCH') return this.patchEvents(request);
    } else {
      if (request.method === 'GET') {
        const hb = this.getHeartbeat();
        return wantsStream ? this.openStream('heartbeat', hb) : json(hb);
      }
      if (request.method === 'PUT') return this.putHeartbeat(request);
    }
    return fbError(405, 'Method not allowed');
  }

  async readBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('too large');
    return JSON.parse(text);
  }

  queryEvents(params) {
    const orderBy = parseQueryValue(params.get('orderBy'));
    let rows;
    if (orderBy === 'ts') {
      const endAt = Number(parseQueryValue(params.get('endAt')));
      rows = this.sql.exec('SELECT id, data FROM events WHERE ts <= ? ORDER BY id', Number.isFinite(endAt) ? endAt : Number.MAX_SAFE_INTEGER).toArray();
    } else {
      const startAt = parseQueryValue(params.get('startAt'));
      rows = typeof startAt === 'string'
        ? this.sql.exec('SELECT id, data FROM events WHERE id >= ? ORDER BY id', startAt).toArray()
        : this.sql.exec('SELECT id, data FROM events ORDER BY id').toArray();
    }
    if (!rows.length) return null;
    const out = {};
    for (const r of rows) out[r.id] = JSON.parse(r.data);
    return out;
  }

  async addEvent(request) {
    let body;
    try { body = await this.readBody(request); } catch (e) { return fbError(400, 'Invalid data; couldn\'t parse JSON object'); }
    const now = Date.now();
    const v = resolveServerValues(body, now);
    // เทียบเท่า .validate ในกฎ Firebase เดิม
    if (!v || typeof v !== 'object' || Array.isArray(v) || !('eventId' in v) || !('text' in v) || !('ts' in v)) {
      return fbError(400, 'Permission denied');
    }
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM events').one().n;
    if (count >= MAX_EVENTS) return fbError(507, 'Inbox full');
    const id = this.nextPushId(now);
    const ts = typeof v.ts === 'number' ? v.ts : now;
    this.sql.exec('INSERT INTO events (id, ts, data) VALUES (?, ?, ?)', id, ts, JSON.stringify(v));
    this.broadcast('events', '/' + id, v);
    return json({ name: id });
  }

  async patchEvents(request) {
    let body;
    try { body = await this.readBody(request); } catch (e) { return fbError(400, 'Invalid data; couldn\'t parse JSON object'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fbError(400, 'Invalid data');
    // อนุญาตเฉพาะการลบ (ค่า null) — การเพิ่มต้องผ่าน POST ที่มีการตรวจข้อมูล
    for (const id of Object.keys(body)) {
      if (body[id] !== null) return fbError(400, 'Permission denied');
    }
    for (const id of Object.keys(body)) this.sql.exec('DELETE FROM events WHERE id = ?', id);
    return json(body);
  }

  getHeartbeat() {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', 'heartbeat').toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  async putHeartbeat(request) {
    let body;
    try { body = await this.readBody(request); } catch (e) { return fbError(400, 'Invalid data; couldn\'t parse JSON object'); }
    const v = resolveServerValues(body, Date.now());
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', 'heartbeat', JSON.stringify(v));
    this.broadcast('heartbeat', '/', v);
    return json(v);
  }

  openStream(kind, snapshot) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const client = { kind, writer };
    this.clients.add(client);
    this.send(client, 'put', { path: '/', data: snapshot });
    this.ensureKeepAlive();
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  send(client, event, data) {
    const chunk = new TextEncoder().encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    client.writer.write(chunk).catch(() => this.drop(client));
  }

  drop(client) {
    if (!this.clients.delete(client)) return;
    client.writer.close().catch(() => {});
    if (!this.clients.size && this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  }

  broadcast(kind, path, data) {
    for (const c of this.clients) if (c.kind === kind) this.send(c, 'put', { path, data });
  }

  ensureKeepAlive() {
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      for (const c of this.clients) this.send(c, 'keep-alive', null);
    }, KEEPALIVE_MS);
  }

  cleanup() {
    this.sql.exec('DELETE FROM events WHERE ts < ?', Date.now() - RETENTION_MS);
  }
}
