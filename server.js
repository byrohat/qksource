import express from "express";
import crypto from "node:crypto";
import { chromium } from "playwright";

// CJ şifresi yalnızca istek süresince burada durur; log ve yanıtlardan silinir.
let activeSecret = "";

const warned = new Set();

function redact(text, limit = 0) {
  let s = String(text ?? "");
  if (activeSecret) s = s.split(String(activeSecret)).join("[REDACTED]");
  s = s.replace(/\s+/g, " ").trim();
  if (limit > 0 && s.length > limit) s = s.slice(0, limit);
  return s;
}

function log(entry) {
  const level = entry.level || "info";
  const payload = {
    ts: new Date().toISOString(),
    level,
    step: entry.step ?? null,
    stepNo: entry.stepNo ?? null,
    stepName: entry.stepName ?? null,
    event: entry.event ?? null,
    email: entry.email ?? null,
    url: entry.url == null ? null : redact(entry.url, 500),
    message: entry.message == null ? null : redact(entry.message, 500),
    detail: entry.detail == null ? null : redact(entry.detail, 500),
    blocker: entry.blocker ?? null,
  };
  const line = JSON.stringify(payload);
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function warnOnce(key, entry) {
  if (warned.has(key)) return;
  warned.add(key);
  log(entry);
}

let shuttingDown = false;
function fatal(event, err) {
  if (shuttingDown) return;
  shuttingDown = true;
  const detail = err instanceof Error ? (err.stack || err.message) : err;
  log({ level: "fatal", step: "process", event, message: "Süreç hatası", detail });
  process.exit(1);
}

process.on("uncaughtException", (err) => fatal("uncaughtException", err));
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));

function envStr(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warnOnce(`timeout:${name}`, {
      level: "warn",
      step: "config",
      event: "invalid-timeout",
      message: `${name} geçersiz, varsayılan ${fallback} ms kullanılacak`,
    });
    return fallback;
  }
  return n;
}

const SEL = {
  loginUrl: envStr("QK_LOGIN_URL", envStr("SEL_LOGIN_URL", "https://www.qksource.com/login")),
  cjLoginBtn: envStr("SEL_CJ_BUTTON", "text=/Login via CJ|CJ/i"),
  cjEmail: envStr("SEL_CJ_EMAIL", 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="mail" i]'),
  cjPassword: envStr("SEL_CJ_PASSWORD", 'input[type="password"]'),
  cjSubmit: envStr("SEL_CJ_SUBMIT", 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login")'),
  cjAuthorize: envStr("SEL_CJ_AUTHORIZE", "text=/Authorize|Allow|Agree|Confirm|Yetki/i"),
  successCheck: envStr("SEL_SUCCESS", "text=/Dashboard|My Store|Welcome|Logout/i"),
  errorText: envStr("SEL_ERROR_TEXT", "text=/incorrect password|wrong password|invalid password|invalid credentials|login failed|account or password|username or password|şifre hatalı|şifre yanlış|hatalı şifre|密码错误|账号或密码|用户名或密码/i"),
};

const DEFAULT_CAPTCHA_SELECTORS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='turnstile']",
  "iframe[title*='captcha' i]",
  ".g-recaptcha",
  "#captcha",
  "text=/captcha|verification code|doğrulama kodu|güvenlik doğrulaması|verify you are human|security check|slide to verify|not a robot|robot değilim/i",
];
const captchaSelectors = envStr("SEL_CAPTCHA", "") ? [envStr("SEL_CAPTCHA", "")] : DEFAULT_CAPTCHA_SELECTORS;

const TIMEOUTS = {
  openLogin: envMs("TIMEOUT_OPEN_LOGIN", 45000),
  cjButton: envMs("TIMEOUT_CJ_BUTTON", 20000),
  popup: envMs("TIMEOUT_POPUP", 8000),
  navigation: envMs("TIMEOUT_NAVIGATION", 30000),
  email: envMs("TIMEOUT_EMAIL", 30000),
  password: envMs("TIMEOUT_PASSWORD", 30000),
  submit: envMs("TIMEOUT_SUBMIT", 30000),
  authorize: envMs("TIMEOUT_AUTHORIZE", 10000),
  success: envMs("TIMEOUT_SUCCESS", 45000),
};

// Adım 3, operatörün gördüğü "CJ giriş butonu bulunamadı" mesajıdır.
const STEPS = {
  browser: {
    n: 1,
    id: "browser",
    name: "Tarayıcıyı başlat",
    selectorEnv: null,
    timeoutLabel: "Tarayıcı başlatılamadı",
    missingLabel: "Tarayıcı başlatılamadı",
    genericLabel: "Tarayıcı başlatılamadı",
  },
  openLogin: {
    n: 2,
    id: "open-login",
    name: "Login sayfasını aç",
    selectorEnv: "QK_LOGIN_URL",
    timeoutLabel: "Login sayfası açılamadı",
    missingLabel: "Login sayfası açılamadı",
    genericLabel: "Login sayfası açılamadı",
  },
  cjButton: {
    n: 3,
    id: "cj-button",
    name: "CJ giriş butonuna tıkla",
    selectorEnv: "SEL_CJ_BUTTON",
    timeoutLabel: "CJ giriş butonuna tıklanamadı",
    missingLabel: "CJ giriş butonu bulunamadı",
    genericLabel: "CJ giriş butonuna tıklanamadı",
  },
  popup: {
    n: 4,
    id: "popup",
    name: "Popup veya yönlendirmeyi algıla",
    selectorEnv: null,
    timeoutLabel: "CJ penceresi veya yönlendirme algılanamadı",
    missingLabel: "CJ penceresi veya yönlendirme algılanamadı",
    genericLabel: "CJ penceresi veya yönlendirme algılanamadı",
  },
  email: {
    n: 5,
    id: "fill-email",
    name: "E-postayı doldur",
    selectorEnv: "SEL_CJ_EMAIL",
    timeoutLabel: "CJ e-posta alanı doldurulamadı",
    missingLabel: "CJ e-posta alanı bulunamadı",
    genericLabel: "CJ e-posta alanı doldurulamadı",
  },
  password: {
    n: 6,
    id: "fill-password",
    name: "Şifreyi doldur",
    selectorEnv: "SEL_CJ_PASSWORD",
    timeoutLabel: "CJ şifre alanı doldurulamadı",
    missingLabel: "CJ şifre alanı bulunamadı",
    genericLabel: "CJ şifre alanı doldurulamadı",
  },
  submit: {
    n: 7,
    id: "submit",
    name: "Girişi gönder",
    selectorEnv: "SEL_CJ_SUBMIT",
    timeoutLabel: "CJ giriş formu gönderilemedi",
    missingLabel: "CJ giriş gönderme butonu bulunamadı",
    genericLabel: "CJ giriş formu gönderilemedi",
  },
  authorize: {
    n: 8,
    id: "authorize",
    name: "Yetki ekranını onayla",
    selectorEnv: "SEL_CJ_AUTHORIZE",
    timeoutLabel: "CJ yetki ekranı onaylanamadı",
    missingLabel: "CJ yetki ekranı onaylanamadı",
    genericLabel: "CJ yetki ekranı onaylanamadı",
  },
  success: {
    n: 9,
    id: "wait-success",
    name: "Başarıyı bekle",
    selectorEnv: "SEL_SUCCESS",
    timeoutLabel: "Giriş sonrası başarı ekranı gelmedi",
    missingLabel: "Giriş sonrası başarı ekranı bulunamadı",
    genericLabel: "Giriş sonrası başarı doğrulanamadı",
  },
};

const CREDENTIAL_RE = /incorrect password|wrong password|invalid password|invalid credentials|incorrect email or password|account or password|username or password|login failed|password is incorrect|şifre hatalı|şifre yanlış|hatalı şifre|yanlış şifre|密码错误|账号或密码|用户名或密码/i;
const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|verification code|doğrulama kodu|güvenlik doğrulaması|verify you are human|security check|slide to verify|not a robot|robot değilim/i;

function isTimeout(err) {
  const msg = String(err?.message || "");
  return err?.name === "TimeoutError" || err?.code === "timeout" || /timeout|timed out|zaman aş/i.test(msg);
}

function isMissing(err) {
  return /waiting for locator|resolved to \d+ elements|not found|No element/i.test(String(err?.message || ""));
}

function isBadSelector(err) {
  return /selector|Unexpected token|Malformed|is not a valid/i.test(String(err?.message || ""));
}

function isTransientNavigation(err) {
  if (!err || err.blockerKind || err.handled || err.code === "bad-url" || isBadSelector(err)) return false;
  const msg = `${err.name || ""} ${err.message || ""}`;
  return /TimeoutError|timeout|timed out|net::ERR_|NS_ERROR_|frame was detached|Execution context was destroyed|Navigation failed|ERR_CONNECTION|ERR_NETWORK|ERR_ABORTED|ERR_EMPTY_RESPONSE|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
}

function blockerError(kind) {
  const err = new Error(kind);
  err.blockerKind = kind;
  err.code = kind;
  return err;
}

function messageFor(step, err) {
  const n = step.n;
  if (err?.blockerKind === "captcha") return `Adım ${n}: Captcha veya doğrulama kodu sayfası algılandı`;
  if (err?.blockerKind === "credentials") return `Adım ${n}: CJ kimlik bilgileri reddedildi`;
  if (err?.code === "bad-url") return `Adım ${n}: Login adresi geçersiz (QK_LOGIN_URL)`;
  if (isBadSelector(err)) return `Adım ${n}: seçici geçersiz (${step.selectorEnv || "seçici"})`;
  if (step.id === "browser") {
    return isTimeout(err) ? `Adım ${n}: Tarayıcı başlatılamadı (zaman aşımı)` : `Adım ${n}: Tarayıcı başlatılamadı`;
  }
  if (step.id === "cj-button" && (err?.code === "missing-button" || isMissing(err))) {
    return isTimeout(err) ? `Adım ${n}: CJ giriş butonu bulunamadı (zaman aşımı)` : `Adım ${n}: CJ giriş butonu bulunamadı`;
  }
  if (isTimeout(err)) return `Adım ${n}: ${step.timeoutLabel} (zaman aşımı)`;
  if (isMissing(err)) return `Adım ${n}: ${step.missingLabel}`;
  return `Adım ${n}: ${step.genericLabel}`;
}

function blockerKindOf(step, err) {
  if (err?.blockerKind === "captcha" || err?.blockerKind === "credentials") return err.blockerKind;
  if (isBadSelector(err)) return "selector";
  if (isTimeout(err)) return "timeout";
  if (step.id === "browser") return "browser";
  return null;
}

function pageOpen(page) {
  try {
    return !!page && !page.isClosed();
  } catch {
    return false;
  }
}

function currentUrl(page) {
  try {
    if (!pageOpen(page)) return null;
    return page.url() || null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Playwright'in kendi zamanlayıcısı, kopuk bir gezinmeden sonra ateşlenmeyebilir.
function withDeadline(work, ms) {
  let timer;
  const promise = Promise.resolve().then(work);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timeout ${ms}ms exceeded`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
  return Promise.race([promise, timeout]);
}

async function selectorVisible(page, selector) {
  try {
    return await page.locator(selector).first().isVisible();
  } catch (err) {
    if (isBadSelector(err)) {
      warnOnce(`selector:${selector}`, {
        level: "warn",
        step: "config",
        event: "bad-selector",
        message: "Seçici değerlendirilemedi",
        detail: err.message,
      });
    }
    return false;
  }
}

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    if (await selectorVisible(page, selector)) return true;
  }
  return false;
}

async function detectBlocker(page, { credentials = true, text = true } = {}) {
  if (!pageOpen(page)) return null;
  if (await anyVisible(page, captchaSelectors)) return { kind: "captcha" };
  if (credentials && await selectorVisible(page, SEL.errorText)) return { kind: "credentials" };
  if (!text) return null;
  let sample = "";
  try {
    sample = (await page.locator("body").innerText({ timeout: 1000 })).slice(0, 4000);
  } catch {
    sample = "";
  }
  if (CAPTCHA_RE.test(sample)) return { kind: "captcha" };
  if (credentials && CREDENTIAL_RE.test(sample)) return { kind: "credentials" };
  return null;
}

async function takeScreenshot(page) {
  if (!pageOpen(page)) return null;
  try {
    const buffer = await page.screenshot({ fullPage: false, timeout: 5000 });
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

async function withNavRetry(ctx, step, fn, { recover, timeoutMs } = {}) {
  const run = () => (timeoutMs ? withDeadline(fn, timeoutMs) : fn());
  try {
    return await run();
  } catch (err) {
    if (!isTransientNavigation(err)) throw err;
    log({
      level: "warn",
      step: step.id,
      stepNo: step.n,
      stepName: step.name,
      event: "retry",
      email: ctx.email,
      url: currentUrl(ctx.active),
      message: `Adım ${step.n}: geçici gezinme hatası, bir kez yeniden deneniyor`,
      detail: err?.message,
    });
    // Zaman aşımında ilk gezinme soketi açık kalabilir; yeniden denemeden önce sayfayı değiştir.
    if (recover) await withDeadline(recover, 3000).catch(() => {});
    return await run();
  }
}

async function replacePage(ctx) {
  await Promise.race([
    ctx.page?.close().catch(() => {}),
    delay(1500),
  ]);
  ctx.page = await withDeadline(() => ctx.context.newPage(), 3000);
  ctx.active = ctx.page;
}

async function closeBrowser(browser) {
  if (!browser) return;
  const result = await Promise.race([
    browser.close().then(() => "closed").catch((err) => {
      log({ level: "warn", step: "browser", event: "close-failed", message: "Tarayıcı kapatılamadı", detail: err?.message });
      return "error";
    }),
    delay(5000).then(() => "timeout"),
  ]);
  if (result === "timeout") {
    log({ level: "warn", step: "browser", event: "close-timeout", message: "Tarayıcı kapatma zaman aşımı" });
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function runStep(ctx, step, fn) {
  log({
    level: "info",
    step: step.id,
    stepNo: step.n,
    stepName: step.name,
    event: "start",
    email: ctx.email,
    url: currentUrl(ctx.active),
    message: `Adım ${step.n} başladı: ${step.name}`,
  });
  try {
    await fn();
    log({
      level: "info",
      step: step.id,
      stepNo: step.n,
      stepName: step.name,
      event: "ok",
      email: ctx.email,
      url: currentUrl(ctx.active),
      message: `Adım ${step.n} tamam: ${step.name}`,
    });
  } catch (err) {
    if (err?.handled) throw err;
    let blocker = null;
    if (!err?.blockerKind && step.id !== "browser") {
      blocker = await withDeadline(
        () => detectBlocker(ctx.active, { credentials: step.n >= STEPS.submit.n }),
        2500,
      ).catch(() => null);
      if (blocker && !err.blockerKind) err.blockerKind = blocker.kind;
    }
    const message = messageFor(step, err);
    const url = currentUrl(ctx.active) || currentUrl(ctx.page);
    const screenshot = await withDeadline(
      async () => (await takeScreenshot(ctx.active)) || (await takeScreenshot(ctx.page)),
      6000,
    ).catch(() => null);
    const kind = blockerKindOf(step, err);
    log({
      level: "error",
      step: step.id,
      stepNo: step.n,
      stepName: step.name,
      event: "fail",
      email: ctx.email,
      url,
      message,
      detail: err?.message,
      blocker: kind,
    });
    const wrapped = new Error(message);
    wrapped.handled = true;
    wrapped.stepId = step.id;
    wrapped.stepNo = step.n;
    wrapped.url = url ? redact(url, 500) : null;
    wrapped.screenshot = screenshot;
    wrapped.blocker = kind;
    throw wrapped;
  }
}

async function onboard({ cjEmail, cjPassword }) {
  activeSecret = String(cjPassword);
  const ctx = {
    email: String(cjEmail),
    browser: null,
    context: null,
    page: null,
    active: null,
    popup: null,
    pendingPopup: null,
  };

  try {
    await runStep(ctx, STEPS.browser, async () => {
      ctx.browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      ctx.context = await ctx.browser.newContext({ viewport: { width: 1280, height: 900 } });
      ctx.page = await ctx.context.newPage();
      ctx.active = ctx.page;
    });

    await runStep(ctx, STEPS.openLogin, async () => {
      if (!isHttpUrl(SEL.loginUrl)) throw Object.assign(new Error("bad-url"), { code: "bad-url" });
      await withNavRetry(ctx, STEPS.openLogin, () => ctx.page.goto(SEL.loginUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.openLogin }), {
        recover: () => replacePage(ctx),
        timeoutMs: TIMEOUTS.openLogin,
      });
    });

    await runStep(ctx, STEPS.cjButton, async () => {
      const btn = ctx.page.locator(SEL.cjLoginBtn).first();
      try {
        await btn.waitFor({ state: "visible", timeout: TIMEOUTS.cjButton });
      } catch (err) {
        if (isTimeout(err) || isMissing(err)) err.code = "missing-button";
        throw err;
      }
      ctx.pendingPopup = ctx.context.waitForEvent("page", { timeout: TIMEOUTS.popup }).catch(() => null);
      await btn.click({ timeout: TIMEOUTS.cjButton });
    });

    await runStep(ctx, STEPS.popup, async () => {
      const popup = await ctx.pendingPopup;
      ctx.popup = popup || null;
      const cj = popup || ctx.page;
      ctx.active = cj;
      log({
        level: "info",
        step: STEPS.popup.id,
        stepNo: STEPS.popup.n,
        stepName: STEPS.popup.name,
        event: popup ? "popup" : "same-tab",
        email: ctx.email,
        url: currentUrl(cj),
        message: popup ? "CJ penceresi açıldı" : "Aynı sekmede devam ediliyor",
      });
      await withNavRetry(ctx, STEPS.popup, () => cj.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }), {
        timeoutMs: TIMEOUTS.navigation,
      });
      const blocker = await detectBlocker(cj, { credentials: false });
      if (blocker?.kind === "captcha") throw blockerError("captcha");
    });

    await runStep(ctx, STEPS.email, async () => {
      const blocker = await detectBlocker(ctx.active, { credentials: false });
      if (blocker?.kind === "captcha") throw blockerError("captcha");
      await ctx.active.locator(SEL.cjEmail).first().fill(ctx.email, { timeout: TIMEOUTS.email });
    });

    await runStep(ctx, STEPS.password, async () => {
      const blocker = await detectBlocker(ctx.active, { credentials: false });
      if (blocker?.kind === "captcha") throw blockerError("captcha");
      await ctx.active.locator(SEL.cjPassword).first().fill(cjPassword, { timeout: TIMEOUTS.password });
    });

    await runStep(ctx, STEPS.submit, async () => {
      const page = ctx.active;
      try {
        await page.locator(SEL.cjSubmit).first().click({ timeout: TIMEOUTS.submit });
      } catch (err) {
        // Popup, gönderimden sonra kapanabilir; tıklama sayfayı kapatmışsa adım tamamdır.
        if (!pageOpen(page)) return;
        throw err;
      }
      if (pageOpen(page)) {
        await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.submit }).catch(() => {});
        await delay(300);
      }
      const blocker = await detectBlocker(page, { credentials: true });
      if (blocker) throw blockerError(blocker.kind);
    });

    await runStep(ctx, STEPS.authorize, async () => {
      if (!pageOpen(ctx.active)) ctx.active = ctx.page;
      if (pageOpen(ctx.active)) {
        const auth = ctx.active.locator(SEL.cjAuthorize).first();
        let visible = false;
        try {
          await auth.waitFor({ state: "visible", timeout: TIMEOUTS.authorize });
          visible = true;
        } catch (err) {
          if (!isTimeout(err)) throw err;
        }
        if (visible) await auth.click({ timeout: TIMEOUTS.authorize });
        else {
          log({
            level: "info",
            step: STEPS.authorize.id,
            stepNo: STEPS.authorize.n,
            stepName: STEPS.authorize.name,
            event: "skip",
            email: ctx.email,
            url: currentUrl(ctx.active),
            message: "Yetki ekranı görünmedi, adım atlandı",
          });
        }
      }
      if (ctx.popup && pageOpen(ctx.popup)) {
        await ctx.popup.waitForEvent("close", { timeout: TIMEOUTS.authorize }).catch(() => {});
      }
      if (pageOpen(ctx.page)) ctx.active = ctx.page;
      const blocker = await detectBlocker(ctx.active, { credentials: true });
      if (blocker) throw blockerError(blocker.kind);
    });

    await runStep(ctx, STEPS.success, async () => {
      const page = pageOpen(ctx.page) ? ctx.page : ctx.active;
      ctx.active = page;
      const success = page.locator(SEL.successCheck).first();
      const deadline = Date.now() + TIMEOUTS.success;
      let tick = 0;
      const successVisible = async () => {
        try {
          return await success.isVisible();
        } catch (err) {
          if (isBadSelector(err)) throw err;
          return false;
        }
      };
      while (Date.now() < deadline) {
        if (await successVisible()) return;
        const blocker = await detectBlocker(page, { credentials: true, text: tick % 4 === 0 });
        if (blocker) throw blockerError(blocker.kind);
        tick += 1;
        await delay(Math.min(400, Math.max(0, deadline - Date.now())));
      }
      if (await successVisible()) return;
      const blocker = await detectBlocker(page, { credentials: true, text: true });
      if (blocker) throw blockerError(blocker.kind);
      throw Object.assign(new Error("Timeout exceeded while waiting for success"), { name: "TimeoutError" });
    });

    const url = currentUrl(ctx.page);
    log({
      level: "info",
      step: "onboard",
      event: "done",
      email: ctx.email,
      url,
      message: "CJ bağlantısı tamamlandı",
    });
    return { ok: true, url: url ? redact(url, 500) : null };
  } catch (err) {
    if (err?.handled) {
      return {
        ok: false,
        error: redact(err.message, 500),
        step: err.stepId,
        url: err.url ?? null,
        screenshot: err.screenshot ?? null,
        blocker: err.blocker ?? null,
      };
    }
    const url = currentUrl(ctx.active) || currentUrl(ctx.page);
    const screenshot = (await takeScreenshot(ctx.active)) || (await takeScreenshot(ctx.page));
    log({
      level: "error",
      step: "onboard",
      event: "fail",
      email: ctx.email,
      url,
      message: "Beklenmeyen otomasyon hatası",
      detail: err?.message,
    });
    return {
      ok: false,
      error: "Beklenmeyen otomasyon hatası",
      step: "onboard",
      url: url ? redact(url, 500) : null,
      screenshot,
      blocker: null,
    };
  } finally {
    activeSecret = "";
    await closeBrowser(ctx.browser);
  }
}

const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) {
  log({
    level: "warn",
    step: "config",
    event: "missing-password",
    message: "APP_PASSWORD tanımlı değil, /healthz dışındaki istekler reddedilecek",
  });
}

const configured = ["QK_LOGIN_URL", "SEL_LOGIN_URL", "SEL_CJ_BUTTON", "SEL_CJ_EMAIL", "SEL_CJ_PASSWORD", "SEL_CJ_SUBMIT", "SEL_CJ_AUTHORIZE", "SEL_SUCCESS", "SEL_ERROR_TEXT", "SEL_CAPTCHA", "TIMEOUT_OPEN_LOGIN", "TIMEOUT_CJ_BUTTON", "TIMEOUT_POPUP", "TIMEOUT_NAVIGATION", "TIMEOUT_EMAIL", "TIMEOUT_PASSWORD", "TIMEOUT_SUBMIT", "TIMEOUT_AUTHORIZE", "TIMEOUT_SUCCESS"]
  .filter((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");
log({ level: "info", step: "config", event: "env", message: configured.length ? `Ayarlı ortam değişkenleri: ${configured.join(", ")}` : "Seçici ve zaman aşımı varsayılanları kullanılıyor" });

const app = express();
app.use(express.json({ limit: "100kb" }));

// Render sağlık kontrolü kimlik doğrulamasız olmalı. Bu rota auth'tan önce kayıtlı.
app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain; charset=utf-8").send("ok");
});

const safeEq = (a = "", b = "") => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.use((req, res, next) => {
  const [type, val] = (req.get("authorization") || "").split(" ");
  const pass = type === "Basic" && val ? Buffer.from(val, "base64").toString().split(":").slice(1).join(":") : "";
  if (APP_PASSWORD && safeEq(pass, APP_PASSWORD)) return next();
  res.set("WWW-Authenticate", 'Basic realm="qksource-onboard"').status(401).send("Yetkisiz");
});

let busy = false;

app.post("/onboard", async (req, res) => {
  const { cjEmail, cjPassword } = req.body || {};
  if (typeof cjEmail !== "string" || typeof cjPassword !== "string" || cjEmail.length === 0 || cjPassword.length === 0) {
    return res.status(400).json({ ok: false, error: "CJ e-posta ve şifre gerekli" });
  }
  if (busy) {
    log({ level: "warn", step: "onboard", event: "busy", email: cjEmail, message: "Başka bir işlem sürüyor" });
    return res.status(429).json({ ok: false, error: "Başka bir işlem sürüyor, biraz sonra deneyin" });
  }
  busy = true;
  log({ level: "info", step: "onboard", event: "start", email: cjEmail, message: "Onboard başladı" });
  try {
    const result = await onboard({ cjEmail, cjPassword });
    res.json(result);
  } catch (err) {
    log({ level: "error", step: "onboard", event: "fail", email: cjEmail, message: "Beklenmeyen sunucu hatası", detail: err?.message });
    res.status(500).json({ ok: false, error: "Beklenmeyen sunucu hatası", step: "onboard", url: null, screenshot: null, blocker: null });
  } finally {
    busy = false;
  }
});

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
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;b.textContent='Çalışıyor... (1-2 dk sürebilir)';r.innerHTML='';
try{const d=Object.fromEntries(new FormData(f));const x=await fetch('/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
const j=await x.json();f.cjPassword.value='';
if(j.ok){r.innerHTML='<p class="ok">✅ Başarılı</p><p>Son URL: '+esc(j.url)+'</p>';}
else{r.innerHTML='<p class="err">❌ Hata: '+esc(j.error||x.status)+'</p>'+(j.url?'<p>URL: '+esc(j.url)+'</p>':'')+(j.screenshot?'<img alt="Hata ekran görüntüsü" src="data:image/png;base64,'+String(j.screenshot).replace(/[^A-Za-z0-9+/=]/g,'')+'">':'');}}
catch(err){r.innerHTML='<p class="err">❌ '+esc(err.message)+'</p>';}
b.disabled=false;b.textContent='Başlat';};
</script></body></html>`));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status || err?.statusCode);
  const code = status >= 400 && status < 500 ? status : 500;
  const parseFailed = err?.type === "entity.parse.failed";
  log({
    level: "error",
    step: "express",
    event: "request-error",
    message: code === 500 ? "Beklenmeyen sunucu hatası" : "Geçersiz istek",
    detail: parseFailed ? "JSON ayrıştırılamadı" : err?.message,
  });
  res.status(code).json({
    ok: false,
    error: code === 400 ? "Geçersiz istek gövdesi" : "Beklenmeyen sunucu hatası",
  });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  const actual = server.address().port;
  log({ level: "info", step: "server", event: "listen", message: `Hazır, port ${actual}` });
});
server.on("error", (err) => fatal("server-error", err));
