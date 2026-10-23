import express from "express";
import crypto from "node:crypto";
import { chromium } from "playwright";

// !!! Bu seçicileri canlı siteye göre DOĞRULAYIN — şu an tahmini değerlerdir.
const SEL = {
  loginUrl: process.env.QK_LOGIN_URL || "https://www.qksource.com/login", // gerçek login URL'i
  cjLoginBtn: "text=/Login via CJ|CJ/i",                 // "Login via CJ" butonu
  cjEmail: 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="mail" i]',
  cjPassword: 'input[type="password"]',
  cjSubmit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login")',
  cjAuthorize: "text=/Authorize|Allow|Agree|Confirm|Yetki/i", // CJ izin ekranı (varsa)
  successCheck: "text=/Dashboard|My Store|Welcome|Logout/i", // giriş sonrası görünen yazı
};

const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) console.warn("UYARI: APP_PASSWORD tanımlı değil, tüm istekler reddedilecek.");

const app = express();
app.use(express.json({ limit: "100kb" }));

const safeEq = (a = "", b = "") => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Basic auth: UI + API
app.use((req, res, next) => {
  const [type, val] = (req.get("authorization") || "").split(" ");
  const pass = type === "Basic" && val ? Buffer.from(val, "base64").toString().split(":").slice(1).join(":") : "";
  if (APP_PASSWORD && safeEq(pass, APP_PASSWORD)) return next();
  res.set("WWW-Authenticate", 'Basic realm="qksource-onboard"').status(401).send("Yetkisiz");
});

let busy = false;

async function onboard({ cjEmail, cjPassword }) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let active = page;
  try {
    await page.goto(SEL.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator(SEL.cjLoginBtn).first().waitFor({ timeout: 20000 });

    // CJ girişi popup ya da aynı sekmede yönlendirme olabilir
    const popupP = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await page.locator(SEL.cjLoginBtn).first().click();
    const popup = await popupP;
    const cj = popup || page;
    active = cj;
    await cj.waitForLoadState("domcontentloaded");

    await cj.locator(SEL.cjEmail).first().fill(cjEmail, { timeout: 30000 });
    await cj.locator(SEL.cjPassword).first().fill(cjPassword);
    await cj.locator(SEL.cjSubmit).first().click();

    const auth = cj.locator(SEL.cjAuthorize).first();
    if (await auth.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)) {
      await auth.click().catch(() => {});
    }

    if (popup) await popup.waitForEvent("close", { timeout: 30000 }).catch(() => {});
    active = page;
    await page.locator(SEL.successCheck).first().waitFor({ timeout: 45000 });
    return { ok: true, url: page.url() };
  } catch (e) {
    let screenshot = null;
    try { screenshot = (await active.screenshot({ fullPage: false })).toString("base64"); } catch {}
    // Şifre asla loglanmaz
    console.error(`onboard hata (${cjEmail}): ${e.message.split("\n")[0]}`);
    return { ok: false, error: e.message.split("\n")[0], url: active.url?.() || null, screenshot };
  } finally {
    await browser.close();
  }
}

app.post("/onboard", async (req, res) => {
  const { cjEmail, cjPassword } = req.body || {};
  if (!cjEmail || !cjPassword) return res.status(400).json({ ok: false, error: "CJ e-posta ve şifre gerekli" });
  if (busy) return res.status(429).json({ ok: false, error: "Başka bir işlem sürüyor, biraz sonra deneyin" });
  busy = true;
  try { res.json(await onboard({ cjEmail, cjPassword })); }
  finally { busy = false; }
});

app.get("/healthz", (_q, r) => r.send("ok"));

app.get("/", (_req, res) => res.type("html").send(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Qksource Hesap Açma</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;display:flex;justify-content:center;padding:40px}
.c{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001;width:100%;max-width:440px}
label{display:block;margin:14px 0 6px;font-weight:600}input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:16px;cursor:pointer}
button:disabled{background:#94a3b8}#r{margin-top:20px;word-break:break-all}.ok{color:#15803d}.err{color:#b91c1c}img{max-width:100%;margin-top:10px;border:1px solid #ddd}</style></head>
<body><div class="c"><h2>Qksource – CJ ile Hesap Aç</h2><form id="f">
<label>CJ e-posta / kullanıcı adı</label><input name="cjEmail" required autocomplete="off">
<label>CJ şifre</label><input name="cjPassword" type="password" required autocomplete="new-password">
<button id="b">Başlat</button></form><div id="r"></div></div>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),r=document.getElementById('r');
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;b.textContent='Çalışıyor... (1-2 dk sürebilir)';r.innerHTML='';
try{const d=Object.fromEntries(new FormData(f));const x=await fetch('/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
const j=await x.json();f.cjPassword.value='';
if(j.ok){r.innerHTML='<p class="ok">✅ Başarılı</p><p>Son URL: '+j.url+'</p>';}
else{r.innerHTML='<p class="err">❌ Hata: '+(j.error||x.status)+'</p>'+(j.url?'<p>URL: '+j.url+'</p>':'')+(j.screenshot?'<img src="data:image/png;base64,'+j.screenshot+'">':'');}}
catch(err){r.innerHTML='<p class="err">❌ '+err.message+'</p>';}
b.disabled=false;b.textContent='Başlat';};
</script></body></html>`));

app.listen(process.env.PORT || 3000, () => console.log("Hazır, port", process.env.PORT || 3000));
