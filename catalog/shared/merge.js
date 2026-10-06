'use strict';
// กฎ merge ของแคตตาล็อก ใช้ร่วมกันทั้ง Worker (cloudflare-inbox/src/catalog.js) และแอป (catalog/*)
// ไฟล์เดียว ไม่มีการ copy: wrangler bundle ไฟล์นี้เข้า Worker เอง
//
//  1. updatedAt มากกว่าชนะ
//  2. เท่ากัน → updatedBy ที่เรียงตามตัวอักษรแล้วมากกว่าชนะ (กำหนดแน่นอน ทุกเครื่องได้ผลเหมือนกัน)
//  3. tombstone (deleted:true) เป็นการแก้แบบหนึ่ง ใช้กฎเดียวกัน
//  4. ล้ำอนาคตเกิน FUTURE_LIMIT_MS ถือว่านาฬิกาเพี้ยน (server ตอบ 409 ให้ client ปรับ offset)

const FUTURE_LIMIT_MS = 10 * 60 * 1000;
const DEFAULT_CATEGORY = 'ทั่วไป';

// > 0 = a ชนะ, < 0 = b ชนะ, 0 = ลายเซ็นเดียวกัน (คือการเขียนครั้งเดียวกัน)
// ค่าว่าง (ยังไม่มีของฝั่งนั้น) แพ้เสมอ
function compareItems(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const ta = Number(a.updatedAt) || 0;
  const tb = Number(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb ? 1 : -1;
  const ua = String(a.updatedBy || '');
  const ub = String(b.updatedBy || '');
  if (ua === ub) return 0;
  return ua > ub ? 1 : -1;
}

// คืนฉบับที่ชนะ (ถ้าเท่ากันคืน local)
function mergeItem(local, remote) {
  return compareItems(remote, local) > 0 ? remote : local;
}

// updatedAt ล้ำเวลา server (now) เกินที่ยอมหรือไม่
function isTooFarInFuture(updatedAt, now, limitMs) {
  return Number(updatedAt) > now + (limitMs == null ? FUTURE_LIMIT_MS : limitMs);
}

// categories ต้องมี 'ทั่วไป' เสมอ ตัดซ้ำ ตัดค่าว่าง คงลำดับเดิม
function normalizeCategories(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    const name = typeof c === 'string' ? c.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!seen.has(DEFAULT_CATEGORY)) out.unshift(DEFAULT_CATEGORY);
  return out;
}

module.exports = { FUTURE_LIMIT_MS, DEFAULT_CATEGORY, compareItems, mergeItem, isTooFarInFuture, normalizeCategories };
