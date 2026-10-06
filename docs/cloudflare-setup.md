# ย้ายช่องทาง ☁️ จาก Firebase ไป Cloudflare

โค้ดฝั่ง Cloudflare อยู่ในโฟลเดอร์ [`cloudflare-inbox/`](../cloudflare-inbox) เป็น Worker เล็กๆ ที่รับคำสั่งแบบเดียวกับ Firebase ที่ POS Hero ใช้
จึง**ไม่ต้องอัปเดตแอป** แค่เปลี่ยน URL ในแอปและใน MacroDroid

- ฟรีในปริมาณของร้านเดียว (แผนฟรี 100,000 request ต่อวัน ส่วน heartbeat ใช้วันละประมาณ 290 ครั้ง)
- แต่ละ Inbox Key มีที่เก็บข้อมูลแยกกัน key ต้องยาวอย่างน้อย 32 ตัวเหมือนเดิม
- ลบแจ้งเตือนที่เก่ากว่า 3 วันเอง และรับได้สูงสุด 5,000 รายการต่อ key
- ไม่ต้องยุ่งกับกฎของ STOCK MASTER ใน Firebase อีก

---

## ขั้นที่ 1 — สมัครและ deploy (ทำครั้งเดียว บนคอมที่มีโค้ด)

1. สมัคร Cloudflare ฟรีที่ https://dash.cloudflare.com/sign-up
2. เปิด Terminal ที่โฟลเดอร์ `D:\Claude\pos-hero\cloudflare-inbox` แล้วรัน:
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   - `wrangler login` จะเปิดเบราว์เซอร์ให้กดอนุญาต
   - ครั้งแรกอาจถามให้ตั้งชื่อ subdomain ของ `workers.dev` ตั้งเป็นชื่อร้านได้
3. ท้ายผลลัพธ์จะมี URL แบบ `https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev` จดเก็บไว้
4. ตรวจว่าทำงาน:
   ```
   set BASE=https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev
   npm test
   ```
   ต้องขึ้น `all passed` (ชุดทดสอบใช้ key สุ่มของตัวเอง ไม่ปนกับข้อมูลร้าน)

## ขั้นที่ 2 — เปลี่ยนในแอป POS Hero

⚙️ ตั้งค่า (ปุ่มที่แผงด้านล่าง) → กล่อง 📥 → ช่อง **Database URL** ใส่ URL จากขั้นที่ 1 (ไม่มี `/` ท้าย)
Inbox Key ใช้ตัวเดิมได้ แอปจะต่อใหม่เอง ไฟ ☁️ ในกล่องต้องขึ้นว่าต่ออยู่

## ขั้นที่ 3 — เปลี่ยนใน MacroDroid (2 จุด)

แก้เฉพาะส่วนต้นของ URL จาก Firebase เป็น URL ของ Worker ส่วนท้ายเหมือนเดิมทุกตัวอักษร

| Macro | เดิม | ใหม่ |
|---|---|---|
| ส่งเงินเข้า POS (HTTP POST) | `https://xxxx.firebasedatabase.app/pos_hero_inbox/<key>/events.json` | `https://pos-hero-inbox.<ชื่อ>.workers.dev/pos_hero_inbox/<key>/events.json` |
| POS heartbeat (HTTP PUT) | `https://xxxx.firebasedatabase.app/pos_hero_inbox/<key>/heartbeat.json` | `https://pos-hero-inbox.<ชื่อ>.workers.dev/pos_hero_inbox/<key>/heartbeat.json` |

Body JSON และ UDP ไม่ต้องแก้

## ขั้นที่ 4 — ทดสอบแล้วค่อยเลิกใช้ Firebase

1. กด 🧪 โหมดทดสอบ แล้วส่งแจ้งเตือนที่ title ขึ้นต้น `TEST` หรือโอนเข้า 1 บาท ผลต้องขึ้นใต้ปุ่ม
2. ใช้ไปสัก 1–2 วัน ถ้าไฟเขียวและรายการเข้าครบ ค่อยลบก้อน `pos_hero_inbox` ออกจากกฎ Firebase (ไม่ลบก็ไม่เป็นไร)

## ดูข้อมูล / แก้ปัญหา

- ดู log สดของ Worker: `npx wrangler tail`
- หน้า Cloudflare dashboard → Workers & Pages → pos-hero-inbox → Metrics ดูจำนวน request และ error
- แก้โค้ดแล้ว deploy ซ้ำด้วย `npx wrangler deploy` ข้อมูลเดิมไม่หาย

---

# เพิ่มระบบ 📦 กระเป๋าสินค้า (Catalog Hero) บน Worker ตัวเดียวกัน

Worker `pos-hero-inbox` ตัวเดิมรับงานกระเป๋าสินค้าด้วย ใช้ URL เดียวกัน deploy คำสั่งเดียว แต่ข้อมูลแยกจาก inbox ขาดกัน
(Durable Object คนละตัว: `Catalog` แยกจาก `Inbox`) ระบบรับเงินโอนไม่ถูกแตะ

- ข้อมูลสินค้าเก็บใน Durable Object (SQLite) ส่วน**รูป**เก็บใน R2 bucket `pos-hero-catalog`
- R2 มีโควตาฟรี (เก็บ 10GB) แต่**ตอนเปิดใช้ครั้งแรก Cloudflare มักขอให้ผูกบัตร** ถ้าไม่อยากผูก ให้แจ้งผู้พัฒนา เพื่อเปลี่ยนไปเก็บเฉพาะรูปในช่องตารางใน Durable Object แทน
- Worker จะ deploy ไม่ผ่านถ้ายังไม่ได้สร้าง bucket (ขั้นที่ A2) รวมถึงตอน deploy เพื่ออัปเดต inbox ด้วย

## ขั้น A1 — เปิด R2 (ทำครั้งเดียว)

1. เข้า https://dash.cloudflare.com → เมนู **R2 Object Storage** → กด **Purchase / Enable R2** แล้วทำตามขั้นตอน
2. ตรวจว่าเปิดแล้ว: ในหน้า R2 ต้องเห็นปุ่ม **Create bucket**

## ขั้น A2 — สร้าง bucket แล้ว deploy ใหม่

```
cd cloudflare-inbox
npx wrangler r2 bucket create pos-hero-catalog
npx wrangler deploy
```

แล้วตรวจให้ครบทั้งชุดเดิมและชุดกระเป๋า (ใช้ key สุ่มของตัวเอง ไม่ปนข้อมูลร้าน):

```
set BASE=https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev
npm test
```

ต้องขึ้น `all passed` สามครั้ง (merge, inbox, catalog)

## ขั้น A3 — ตั้ง Catalog Key และรหัสเขียน

Catalog Key คือ "กุญแจเปิดกระเป๋า" ยาว 32–128 ตัว (`A-Z a-z 0-9 _ -`) ใช้แบบเดียวกับ Inbox Key แต่**ให้ใช้คนละค่ากัน**
แอปจะสุ่มให้ 40 ตัวในหน้า ตั้งค่า Cloudflare ของกระเป๋าสินค้า (เฟสถัดไป) ถ้าอยากทดสอบด้วยมือ:

```
set KEY=<key ยาวอย่างน้อย 32 ตัว>
curl -X POST https://pos-hero-inbox.<ชื่อ>.workers.dev/catalog/%KEY%/init -d "{\"writeToken\":\"<รหัสเขียน 16 ตัวขึ้นไป>\"}"
```

- **ใครมี key = ดูได้อย่างเดียว** (เหมาะกับเครื่องโชว์หรือเครื่องพนักงาน)
- **การแก้ไข ต้องมี Write token** ส่งใน header `X-Catalog-Write` Worker เก็บเป็นแฮชเท่านั้น ตั้งได้ครั้งเดียว (ตั้งซ้ำได้ `409`)
- ลืม Write token: สร้าง Catalog Key ใหม่ แล้วนำเข้าข้อมูลจากสำเนาในเครื่อง/ไฟล์สำรอง `/catalog/<key>/export`

## ปลายทางทั้งหมด

| Method | Path | ทำอะไร |
|---|---|---|
| GET | `/catalog/{key}/health` | สถานะ `{ok, rev, itemCount, serverTime, initialized}` |
| POST | `/catalog/{key}/init` | ตั้ง Write token ครั้งแรก |
| GET | `/catalog/{key}/changes?since=<rev>&limit=500` | ดึงเฉพาะที่เปลี่ยนหลัง rev นั้น |
| POST | `/catalog/{key}/items` | ส่งสินค้า ≤ 200 ชิ้น/ครั้ง (รวมทีละชิ้นตามเวลาแก้ล่าสุด) |
| PUT | `/catalog/{key}/meta` | หมวดหมู่ / ชื่อร้าน |
| PUT / GET | `/catalog/{key}/img/{sha256}/{orig\|full\|thumb}[-v{n}]` | อัปโหลด / ดึงรูป (≤ 5MB, JPEG หรือ WebP, cache ถาวร) |
| GET | `/catalog/{key}/export` | สำรองทั้ง catalog เป็น JSON (ไม่รวมรูป) ใส่ `?deleted=1` ถ้าอยากได้รายการที่ลบด้วย |

## ข้อควรรู้

- ทุกเครื่องเรียก `changes?since=` เท่านั้น ไม่ดึงทั้งก้อนทุกรอบ ใช้ไม่ถึงหมื่น request ต่อวันสำหรับ 2 สาขา
- นาฬิกาเครื่องเร็วกว่าเซิร์ฟเวอร์เกิน 10 นาที: Worker ตอบ `409 clock-skew` พร้อมเวลาจริง แอปจะปรับเวลาแล้วส่งใหม่เอง
- รายการที่ลบ (tombstone) เก็บ 90 วันแล้วล้าง เครื่องที่ไม่ได้ซิงก์นานกว่านั้นจะได้ `resetRequired` แล้วแอปดึงทั้งหมดใหม่
- รูปที่ประมวลผลใหม่ใช้ชื่อใหม่ (`thumb-v2`) ไม่เขียนทับชื่อเดิม เพราะรูปถูก cache แบบ immutable
- ดู log สด: `npx wrangler tail`
