'use strict';
// ตรรกะคูปองส่วนลดตามยอด (ไม่พึ่ง Electron — ทดสอบด้วย node ได้)
// ใช้โดย fortune-main.js: ยอดค้าง (pending), เลือกขั้น, สร้างรหัส, เก็บ/ตรวจคูปอง
const fs = require('fs');
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี 0/O/1/I กันอ่านผิด
const DEFAULT_TIERS = [{ min: 500, percent: 5 }, { min: 1000, percent: 10 }];
const DAY_MS = 24 * 60 * 60 * 1000;

// "1,250" / "฿350" / "850 บาท" / 99.5 → number > 0 หรือ null (ไม่รับค่าติดลบ/ศูนย์/ตัวอักษรปน)
function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 && input < 10000000 ? input : null;
  const s = String(input == null ? '' : input).replace(/[,\s฿]/g, '').replace(/บาท$/, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// รับอะไรมาก็ได้ คืน [{min,percent}] ที่ถูกต้อง เรียง min น้อย→มาก; ไม่ใช่ array → ค่าตั้งต้น
function normalizeTiers(t) {
  if (!Array.isArray(t)) return DEFAULT_TIERS.map((x) => ({ ...x }));
  const byMin = new Map();
  for (const x of t) {
    const min = Number(x && x.min), percent = Number(x && x.percent);
    if (!Number.isFinite(min) || min <= 0 || min > 10000000) continue;
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) continue;
    byMin.set(min, { min, percent });
  }
  return [...byMin.values()].sort((a, b) => a.min - b.min);
}

// ขั้นสูงสุดที่ยอด >= min; ไม่ถึงขั้นแรก = null
function pickTier(tiers, amount) {
  const a = parseAmount(amount);
  if (a == null) return null;
  let best = null;
  for (const t of normalizeTiers(tiers)) if (a >= t.min) best = t;
  return best;
}

function sanitizePrefix(p) {
  const s = String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return s;
}
function normalizeCode(c) { return String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function displayCode(code) { // SHABC234 → SH-ABC234
  const c = normalizeCode(code);
  return c.length > 6 ? c.slice(0, c.length - 6) + '-' + c.slice(-6) : c;
}

function genCode(prefix, randInt, taken) {
  const p = sanitizePrefix(prefix);
  for (let tries = 0; tries < 50; tries++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += ALPHABET[randInt(ALPHABET.length)];
    if (!taken || !taken.has(p + s)) return p + s;
  }
  throw new Error('cannot generate unique coupon code');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function thaiDate(ts) { // วว/ดด/ปปปป (พ.ศ.)
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear() + 543}`;
}
function endOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ยอดที่แคชเชียร์กรอกไว้รอบิลถัดไป: ใช้ครั้งเดียว หมดอายุเอง
function createPending({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  let amount = null, at = 0;
  const fresh = () => amount != null && now() - at <= ttlMs;
  return {
    set(a) { const n = parseAmount(a); if (n == null) return false; amount = n; at = now(); return true; },
    peek() { return fresh() ? amount : null; },
    take() { const v = fresh() ? amount : null; amount = null; at = 0; return v; },
    clear() { amount = null; at = 0; },
    remainingMs() { return fresh() ? Math.max(0, ttlMs - (now() - at)) : 0; }
  };
}

// ประวัติคูปองที่ออก (ไฟล์ JSON) — mint สร้างในหน่วยความจำ, commit บันทึกจริงหลังพิมพ์สำเร็จเท่านั้น
function createCouponStore({ file, now = Date.now, randInt = (n) => crypto.randomInt(n) }) {
  let list = [];
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j)) list = j.filter((c) => c && typeof c.code === 'string'); } catch (e) { list = []; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(list, null, 2)); return true; } catch (e) { return false; } };
  const find = (code) => { const c = normalizeCode(code); return list.find((x) => x.code === c) || null; };
  const statusOf = (c) => (!c ? 'notfound' : c.usedAt ? 'used' : now() > c.expiresAt ? 'expired' : 'valid');

  return {
    mint({ amount, percent, prefix, validDays }) {
      const days = Math.min(365, Math.max(1, Math.floor(Number(validDays)) || 30));
      const issuedAt = now();
      const taken = new Set(list.map((c) => c.code));
      return {
        code: genCode(prefix, randInt, taken), percent, amount,
        issuedAt, expiresAt: endOfLocalDay(issuedAt + days * DAY_MS), usedAt: null
      };
    },
    commit(rec) { list.push(rec); if (list.length > 5000) list = list.slice(-5000); return save(); },
    check(code) { const c = find(code); return { status: statusOf(c), coupon: c ? { ...c } : null }; },
    markUsed(code) {
      const c = find(code);
      const st = statusOf(c);
      if (st !== 'valid') return { status: st, coupon: c ? { ...c } : null };
      c.usedAt = now();
      return { status: save() ? 'marked' : 'save-failed', coupon: { ...c } };
    },
    recent(n = 20) { return list.slice(-n).reverse().map((c) => ({ ...c, status: statusOf(c) })); }
  };
}

module.exports = {
  ALPHABET, DEFAULT_TIERS, parseAmount, normalizeTiers, pickTier, sanitizePrefix, normalizeCode, displayCode,
  genCode, thaiDate, endOfLocalDay, createPending, createCouponStore
};
