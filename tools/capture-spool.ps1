# เก็บตัวอย่างไฟล์ spool ของใบเสร็จ เพื่อดูว่าอ่านยอดเงินจากใบเสร็จอัตโนมัติได้ไหม
# ต้อง "Run as Administrator" (โฟลเดอร์ spool อ่านด้วยสิทธิ์ผู้ใช้ปกติไม่ได้)
#
# วิธีใช้ (ที่เครื่องหน้าร้าน):
#   1) เปิด PowerShell แบบ Run as Administrator
#   2) powershell -ExecutionPolicy Bypass -File capture-spool.ps1
#   3) ขายจริง/พิมพ์ใบเสร็จ 3-5 ใบ (ยอดต่างกัน และจดยอดไว้) แล้วกด Ctrl+C
#   4) ส่งโฟลเดอร์ปลายทาง (ค่าเริ่มต้น Desktop\spool-samples) มาให้ — ไฟล์เหล่านี้อาจมีข้อมูลบิล ส่งเฉพาะคนที่ไว้ใจ
#
# หมายเหตุ: Windows ลบไฟล์ spool ทันทีที่พิมพ์เสร็จ สคริปต์จึงสแกนทุก 50 ms แล้วคัดลอกทันที
# ถ้าได้ไฟล์น้อย/ว่าง ให้ไปที่ Printer Properties > Advanced > ติ๊ก "Keep printed documents" แล้วลองใหม่

param(
    [string]$Dest = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'spool-samples'),
    [string]$SpoolDir = (Join-Path $env:SystemRoot 'System32\spool\PRINTERS')
)

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'ต้องรันแบบ Run as Administrator' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "เฝ้าดู $SpoolDir  ->  $Dest   (กด Ctrl+C เพื่อหยุด)"
$copied = @{}
while ($true) {
    try {
        foreach ($f in (Get-ChildItem -LiteralPath $SpoolDir -File -ErrorAction Stop)) {
            $key = $f.Name + '|' + $f.Length
            if ($copied.ContainsKey($key)) { continue }
            $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
            $target = Join-Path $Dest ("$stamp-" + $f.Name)
            try {
                Copy-Item -LiteralPath $f.FullName -Destination $target -ErrorAction Stop
                $copied[$key] = $true
                Write-Host ("คัดลอก {0} ({1} bytes)" -f $f.Name, $f.Length)
            } catch { }  # ไฟล์ยังถูกล็อกอยู่ จะลองใหม่รอบหน้า
        }
    } catch { Write-Host ('อ่านโฟลเดอร์ spool ไม่ได้: ' + $_.Exception.Message) -ForegroundColor Red; Start-Sleep -Seconds 2 }
    Start-Sleep -Milliseconds 50
}
