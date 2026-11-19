import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version || '1.6.0';
const notes = pkg.releaseNotes || 'Iris Studio Release';
const distDir = path.join(root, 'dist');
let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

const cssMatch = html.match(/href="\.?\/assets\/([^"]+\.css)"/);
const jsMatch = html.match(/src="\.?\/assets\/([^"]+\.js)"/);

if (!cssMatch || !jsMatch) {
  throw new Error('Could not find CSS/JS asset tags in dist/index.html');
}

const css = fs.readFileSync(path.join(distDir, 'assets', cssMatch[1]), 'utf8');
const js = fs.readFileSync(path.join(distDir, 'assets', jsMatch[1]), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]+>/, () => `<style>${css}</style>`);
html = html.replace(/<script type="module"[^>]+><\/script>/, () => `<script type="module">${js}</script>`);

// 1. Write full self-contained Web/Offline Studio App bundles
fs.writeFileSync(path.join(distDir, 'Iris-Offline.html'), html, 'utf8');
fs.writeFileSync(path.join(distDir, 'app.html'), html, 'utf8');
fs.writeFileSync(path.join(root, 'Iris-Offline.html'), html, 'utf8');

const iconSrc = path.join(root, 'native', 'iris_logo_512.png');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(distDir, 'iris_logo_512.png'));
}

// 2. Write manifest for OTA auto-update
const dmgUrl = `https://github.com/memories-stack/iris/releases/download/v${version}/Iris-Installer.dmg`;
const pkgUrl = `https://github.com/memories-stack/iris/releases/download/v${version}/Iris-Installer.pkg`;
const zipUrl = `https://github.com/memories-stack/iris/releases/download/v${version}/Iris-Mac.zip`;
const manifest = {
  version,
  minNativeVersion: '1.6.0',
  releasedAt: new Date().toISOString(),
  notes,
  htmlUrl: 'https://memories-stack.github.io/iris/Iris-Offline.html',
  dmgUrl,
  pkgUrl,
  zipUrl,
};
fs.writeFileSync(path.join(distDir, 'version.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 3. Write sleek Landing & Download Page to dist/index.html (root GitHub Pages)
const landingHtml = `<!doctype html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Iris — AI Photo Blur &amp; Eye Focus Culling Studio (macOS)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: radial-gradient(circle at 20% 10%, #0d1f2d 0%, #070b14 60%, #030712 100%);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      padding: 28px 16px 52px;
      line-height: 1.55;
    }
    .card {
      width: 100%;
      max-width: 540px;
      background: rgba(15, 23, 42, 0.82);
      border: 1px solid rgba(45, 212, 191, 0.22);
      border-radius: 24px;
      padding: 30px 26px;
      box-shadow: 0 28px 68px rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(20px);
    }
    .header-brand {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 18px;
    }
    .logo-img {
      width: 72px;
      height: 72px;
      border-radius: 18px;
      box-shadow: 0 10px 28px rgba(45, 212, 191, 0.25);
      flex-shrink: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 13px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      color: #5eead4;
      background: rgba(45, 212, 191, 0.14);
      border: 1px solid rgba(45, 212, 191, 0.38);
      margin-bottom: 6px;
    }
    h1 {
      font-size: 29px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.18;
      color: #ffffff;
    }
    .subtitle {
      font-size: 14.5px;
      color: #94a3b8;
      margin-bottom: 22px;
    }
    .btn-primary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 15px 18px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      color: #041019;
      text-decoration: none;
      background: linear-gradient(90deg, #2dd4bf 0%, #38bdf8 55%, #fb923c 100%);
      box-shadow: 0 10px 28px rgba(45, 212, 191, 0.32);
      transition: transform 0.15s ease, filter 0.15s ease;
      margin-bottom: 10px;
    }
    .btn-primary:hover { transform: translateY(-1px); filter: brightness(1.06); }
    .btn-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .btn-secondary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 11px 12px;
      border-radius: 12px;
      font-size: 13.5px;
      font-weight: 600;
      color: #e2e8f0;
      text-decoration: none;
      background: rgba(30, 41, 59, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.24);
      transition: background 0.15s ease;
      text-align: center;
    }
    .btn-secondary:hover { background: rgba(51, 65, 85, 0.88); }
    .features {
      display: flex;
      flex-direction: column;
      gap: 11px;
      margin: 22px 0;
    }
    .feat-box {
      background: rgba(15, 23, 42, 0.68);
      border: 1px solid rgba(148, 163, 184, 0.15);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .feat-title {
      font-size: 14.5px;
      font-weight: 700;
      color: #f8fafc;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .feat-desc {
      font-size: 13.2px;
      color: #94a3b8;
    }
    .guide-box {
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(251, 191, 36, 0.28);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 13px;
      color: #cbd5e1;
    }
    .guide-box strong { color: #fcd34d; }
    .guide-box ol { margin: 8px 0 0 18px; }
    .guide-box li { margin-bottom: 4px; }
    .footer {
      margin-top: 18px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="header-brand">
      <img class="logo-img" src="./iris_logo_512.png" alt="Iris Logo" />
      <div>
        <div class="badge" id="ver-badge">Iris v${version} • macOS Universal (Apple Silicon &amp; Intel)</div>
        <h1>Iris — AI Photo Culling</h1>
      </div>
    </div>

    <p class="subtitle">
      สตูดิโอคัดภาพเบลอและตรวจโฟกัสดวงตา AI ความเร็วสูง (~250 รูป/วินาที) สำหรับช่างภาพงานวิ่งมาราธอน งานอีเวนต์ และพอร์ตเทรต รองรับไฟล์ JPEG + RAW คู่กัน 5,000+ ภาพ พร้อมระบบพรีวิวภาพเบลอและกู้ความคมชัด WebGL2 RCAS (ออฟไลน์ 100%)
    </p>

    <a id="dmg-btn" class="btn-primary" href="${dmgUrl}">
      ⬇️ ดาวน์โหลด Iris-Installer.dmg (macOS)
    </a>

    <div class="btn-row">
      <a id="pkg-btn" class="btn-secondary" href="${pkgUrl}">📦 ตัวติดตั้ง .PKG</a>
      <a id="zip-btn" class="btn-secondary" href="${zipUrl}">🗜️ ไฟล์แอป .ZIP</a>
    </div>

    <div class="btn-row" style="margin-bottom: 6px;">
      <a class="btn-secondary" style="border-color:rgba(45,212,191,0.4);color:#5eead4;" href="./app.html">🌐 เปิดใช้งานบนเว็บ</a>
      <a class="btn-secondary" href="https://github.com/memories-stack/iris/releases/latest">🚀 ดู Releases ทั้งหมด</a>
    </div>

    <div class="features">
      <div class="feat-box">
        <div class="feat-title">👁️ 2-Stage Hybrid AI Eye &amp; Runner Focus Engine</div>
        <div class="feat-desc">สแกน 12×12 Multi-Subject Grid ร่วมกับ Apple Vision Neural Engine ตรวจจับใบหน้า ดวงตา ร่างกายนักวิ่ง (แม้ใส่โม่งปิดหน้า) และอ่านเบอร์บิบ (Race Bib OCR) อัตโนมัติ</div>
      </div>
      <div class="feat-box">
        <div class="feat-title">⚡ ความเร็ว ~250 ภาพ/วินาที (รองรับ 5,000+ ภาพ &amp; RAW)</div>
        <div class="feat-desc">ประมวลผลด้วย Multi-Core C Grand Central Dispatch ลื่นไหลไม่ค้าง แยกโฟลเดอร์ _ภาพคมชัด, _พอใช้, _ภาพเบลอ พร้อมย้ายไฟล์ RAW (.NEF, .ARW, .CR3) คู่กันใน 0.05 วินาที</div>
      </div>
      <div class="feat-box">
        <div class="feat-title">👁️🗑️ พรีวิวภาพเบลอขนาดใหญ่ &amp; ลบลงถังขยะ Mac ทันที</div>
        <div class="feat-desc">เปิดดูภาพที่ถูกคัดว่าเบลอแบบเต็มตา ซูมเช็ก 400% กดปุ่ม Delete ลบทีละภาพ หรือลบภาพเบลอทั้งหมดลง macOS Trash ได้ในคลิกเดียว</div>
      </div>
      <div class="feat-box">
        <div class="feat-title">✨ กู้ภาพหลุดโฟกัสด้วย WebGL2 RCAS &amp; OTA Auto-Update</div>
        <div class="feat-desc">กู้ภาพ Soft Focus ให้กลับมาคมชัดสีผิวสวยเป็นธรรมชาติ และมีปุ่มเช็ก/อัปเดตเวอร์ชันใหม่มุมบนขวาภายในแอปโดยตรง</div>
      </div>
    </div>

    <div class="guide-box">
      <strong>🍎 วิธีเปิดแอปครั้งแรกบน macOS (ทำครั้งเดียว):</strong>
      <ol>
        <li>หากขึ้นแจ้งเตือน <em>"Iris Not Opened"</em> ให้กด <strong>Done</strong></li>
        <li>เปิด <strong>System Settings</strong> (รูปเฟือง) → <strong>Privacy &amp; Security</strong></li>
        <li>เลื่อนลงล่างสุด กดปุ่ม <strong>Open Anyway</strong> → ใส่รหัสเครื่อง Mac ก็ใช้งานได้ตลอดชีพครับ</li>
      </ol>
    </div>

    <div class="footer">
      Iris Studio v${version} • Apple Silicon (M1–M4) &amp; Intel Universal • 100% Offline Processing
    </div>
  </main>

  <script>
    fetch('./version.json?t=' + Date.now())
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || !d.version) return;
        var b = document.getElementById('ver-badge');
        var a = document.getElementById('dmg-btn');
        var p = document.getElementById('pkg-btn');
        var z = document.getElementById('zip-btn');
        if (b) b.textContent = 'Iris v' + d.version + ' • macOS Universal (Apple Silicon & Intel)';
        if (a && d.dmgUrl) a.href = d.dmgUrl;
        if (p && d.pkgUrl) p.href = d.pkgUrl;
        if (z && d.zipUrl) z.href = d.zipUrl;
      })
      .catch(function() {});
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(distDir, 'index.html'), landingHtml, 'utf8');
console.log(`Generated dist/index.html (Landing), dist/app.html & dist/Iris-Offline.html (${html.length} bytes), and dist/version.json (v${version})`);
