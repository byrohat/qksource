import express from "express";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

// CJ şifresi ve doğrulama kodu yalnızca işlem sırasında burada durur; loglara yazılmaz.
let activeSecrets = [];

const warned = new Set();
const sessions = new Map();
let activeSessionId = null;

function proxyRedactions() {
  const raw = typeof process.env.PROXY_URL === "string" ? process.env.PROXY_URL.trim() : "";
  if (!raw) return [];
  const list = [raw];
  try {
    const url = new URL(raw);
    const password = url.password ? decodeURIComponent(url.password) : "";
    if (password.length >= 4) list.push(password);
  } catch {
    // PROXY_URL ayrışmazsa yalnızca ham değer gizlenir.
  }
  return list;
}

function redact(text, limit = 0) {
  let s = String(text ?? "");
  for (const secret of [...activeSecrets, ...proxyRedactions()]) {
    if (secret) s = s.split(String(secret)).join("[REDACTED]");
  }
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
    sessionId: entry.sessionId ?? null,
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

const CJ_BUTTON_OVERRIDE = envStr("SEL_CJ_BUTTON", "");
const CAPTCHA_INPUT = envStr("SEL_CAPTCHA_INPUT", "input[placeholder*='verification code' i], input[placeholder*='doğrulama kodu' i], input[aria-label*='verification code' i], input[name='code' i], input[name*='verify' i], input[id*='captcha' i]");
const CAPTCHA_SUBMIT = envStr("SEL_CAPTCHA_SUBMIT", "button:has-text('Submit'), button:has-text('Gönder'), input[type='submit']");
const CAPTCHA_IMAGE = envStr("SEL_CAPTCHA_IMAGE", "");
const CAPTCHA_WIDGETS = envStr("SEL_CAPTCHA", "")
  ? [envStr("SEL_CAPTCHA", "")]
  : ["iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='turnstile']", ".g-recaptcha", "#captcha"];

const SEL = {
  loginUrl: envStr("QK_LOGIN_URL", envStr("SEL_LOGIN_URL", "https://qksource.com/register.html")),
  cjEmail: envStr("SEL_CJ_EMAIL", 'input[type="email"], input[name="email" i], input[name="username" i], input[name="account" i], input[placeholder*="mail" i], input[placeholder*="user" i], input[id*="email" i]'),
  cjPassword: envStr("SEL_CJ_PASSWORD", 'input[type="password"]'),
  cjSubmit: envStr("SEL_CJ_SUBMIT", 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")'),
  cjAuthorize: envStr("SEL_CJ_AUTHORIZE", "button:has-text('Authorize'), button:has-text('Allow'), button:has-text('Agree'), button:has-text('Confirm'), button:has-text('Yetki')"),
  successCheck: envStr("SEL_SUCCESS", "text=/Dashboard|My Store|Logout|Sign out|Log out|Hesabım/i"),
  errorText: envStr("SEL_ERROR_TEXT", "text=/incorrect password|wrong password|invalid password|invalid credentials|login failed|account or password|username or password|şifre hatalı|şifre yanlış|hatalı şifre|密码错误|账号或密码|用户名或密码/i"),
};

const TIMEOUTS = {
  openLogin: envMs("TIMEOUT_OPEN_LOGIN", timeoutDefault(45000)),
  captcha: envMs("TIMEOUT_CAPTCHA", timeoutDefault(20000)),
  cjButton: envMs("TIMEOUT_CJ_BUTTON", timeoutDefault(20000)),
  popup: envMs("TIMEOUT_POPUP", timeoutDefault(8000)),
  navigation: envMs("TIMEOUT_NAVIGATION", timeoutDefault(30000)),
  email: envMs("TIMEOUT_EMAIL", timeoutDefault(30000)),
  password: envMs("TIMEOUT_PASSWORD", timeoutDefault(30000)),
  submit: envMs("TIMEOUT_SUBMIT", timeoutDefault(30000)),
  authorize: envMs("TIMEOUT_AUTHORIZE", timeoutDefault(10000)),
  success: envMs("TIMEOUT_SUCCESS", timeoutDefault(45000)),
};

const SESSION_TTL = envMs("SESSION_TTL_MS", 5 * 60 * 1000);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROWSER_LOCALE = envStr("BROWSER_LOCALE", "de-DE");
const BROWSER_TZ = envStr("BROWSER_TZ", "Europe/Berlin");
const BROWSER_UA = envStr("BROWSER_UA", "");
const PROXY_URL = envStr("PROXY_URL", "");
const GEO_ERROR = "Adım 3: qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın.";
const GEO_TEXT = /only accessible to European sites/i;

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
    name: "Kayıt sayfasını aç",
    selectorEnv: "QK_LOGIN_URL",
    timeoutLabel: "Kayıt sayfası açılamadı",
    missingLabel: "Kayıt sayfası açılamadı",
    genericLabel: "Kayıt sayfası açılamadı",
  },
  geo: {
    n: 3,
    id: "geo",
    name: "Bölge erişimini kontrol et",
    selectorEnv: "PROXY_URL",
    timeoutLabel: "qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın",
    missingLabel: "qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın",
    genericLabel: "qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın",
  },
  captcha: {
    n: 3,
    id: "captcha",
    name: "Doğrulama kodunu gönder",
    selectorEnv: "SEL_CAPTCHA_INPUT",
    timeoutLabel: "Doğrulama kodu gönderilemedi",
    missingLabel: "Doğrulama kodu alanı bulunamadı",
    genericLabel: "Doğrulama kodu gönderilemedi",
  },
  cjButton: {
    n: 4,
    id: "cj-button",
    name: "CJ ikonuna tıkla",
    selectorEnv: "SEL_CJ_BUTTON",
    timeoutLabel: "CJ giriş ikonuna tıklanamadı",
    missingLabel: "CJ giriş ikonu bulunamadı",
    genericLabel: "CJ giriş ikonuna tıklanamadı",
  },
  popup: {
    n: 5,
    id: "popup",
    name: "Popup veya yönlendirmeyi algıla",
    selectorEnv: null,
    timeoutLabel: "CJ penceresi veya yönlendirme algılanamadı",
    missingLabel: "CJ penceresi veya yönlendirme algılanamadı",
    genericLabel: "CJ penceresi veya yönlendirme algılanamadı",
  },
  email: {
    n: 6,
    id: "fill-email",
    name: "E-postayı doldur",
    selectorEnv: "SEL_CJ_EMAIL",
    timeoutLabel: "CJ e-posta alanı doldurulamadı",
    missingLabel: "CJ e-posta alanı bulunamadı",
    genericLabel: "CJ e-posta alanı doldurulamadı",
  },
  password: {
    n: 7,
    id: "fill-password",
    name: "Şifreyi doldur",
    selectorEnv: "SEL_CJ_PASSWORD",
    timeoutLabel: "CJ şifre alanı doldurulamadı",
    missingLabel: "CJ şifre alanı bulunamadı",
    genericLabel: "CJ şifre alanı doldurulamadı",
  },
  submit: {
    n: 8,
    id: "submit",
    name: "Girişi gönder",
    selectorEnv: "SEL_CJ_SUBMIT",
    timeoutLabel: "CJ giriş formu gönderilemedi",
    missingLabel: "CJ giriş gönderme butonu bulunamadı",
    genericLabel: "CJ giriş formu gönderilemedi",
  },
  authorize: {
    n: 9,
    id: "authorize",
    name: "Yetki ekranını onayla",
    selectorEnv: "SEL_CJ_AUTHORIZE",
    timeoutLabel: "CJ yetki ekranı onaylanamadı",
    missingLabel: "CJ yetki ekranı onaylanamadı",
    genericLabel: "CJ yetki ekranı onaylanamadı",
  },
  success: {
    n: 10,
    id: "wait-success",
    name: "Başarıyı bekle",
    selectorEnv: "SEL_SUCCESS",
    timeoutLabel: "Giriş sonrası başarı ekranı gelmedi",
    missingLabel: "Giriş sonrası başarı ekranı bulunamadı",
    genericLabel: "Giriş sonrası başarı doğrulanamadı",
  },
};

const PHASES = ["cjButton", "popup", "email", "password", "submit", "authorize", "success"];

const CREDENTIAL_RE = /incorrect password|wrong password|invalid password|invalid credentials|incorrect email or password|account or password|username or password|login failed|password is incorrect|şifre hatalı|şifre yanlış|hatalı şifre|yanlış şifre|密码错误|账号或密码|用户名或密码/i;

function timeoutDefault(ms) {
  const proxy = typeof process.env.PROXY_URL === "string" && process.env.PROXY_URL.trim();
  return proxy ? ms * 3 : ms;
}

function isTimeout(err) {
  const msg = String(err?.message || "");
  return err?.name === "TimeoutError" || err?.code === "timeout" || /timeout|timed out|zaman aş/i.test(msg);
}

function isContextDestroyed(err) {
  const msg = `${err?.name || ""} ${err?.message || ""}`;
  return /Execution context was destroyed|frame was detached|Navigation failed|Target closed|most likely because of a navigation|Execution context is not available|not attached to the DOM/i.test(msg);
}

function isMissing(err) {
  return /waiting for locator|resolved to \d+ elements|not found|No element/i.test(String(err?.message || ""));
}

function isBadSelector(err) {
  return /selector|Unexpected token|Malformed|is not a valid/i.test(String(err?.message || ""));
}

function isTransientNavigation(err) {
  if (!err || err.blockerKind || err.handled || err.captchaPause || err.code === "bad-url" || err.code === "geo" || err.code === "bad-proxy" || isBadSelector(err)) return false;
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
  if (err?.blockerKind === "geo" || err?.code === "geo") return GEO_ERROR;
  if (err?.code === "bad-proxy") return `Adım ${n}: PROXY_URL geçersiz`;
  if (err?.blockerKind === "credentials") return `Adım ${n}: CJ kimlik bilgileri reddedildi`;
  if (err?.code === "bad-url") return `Adım ${n}: Kayıt adresi geçersiz (QK_LOGIN_URL)`;
  if (err?.code === "no-redirect") return `Adım ${n}: CJ penceresi veya yönlendirme algılanamadı. ${err.surfaces || ""}`.trim();
  if (err?.code === "not-left") return `Adım ${n}: CJ ikonu WhatsApp'ın solunda değil${err.position ? ` (${err.position})` : ""}`;
  if (isBadSelector(err)) return `Adım ${n}: seçici geçersiz (${step.selectorEnv || "seçici"})`;
  if (step.id === "browser") {
    return isTimeout(err) ? `Adım ${n}: Tarayıcı başlatılamadı (zaman aşımı)` : `Adım ${n}: Tarayıcı başlatılamadı`;
  }
  if (step.id === "cj-button" && (err?.code === "missing-button" || isMissing(err))) {
    return isTimeout(err) ? `Adım ${n}: CJ giriş ikonu bulunamadı (zaman aşımı)` : `Adım ${n}: CJ giriş ikonu bulunamadı`;
  }
  if (isTimeout(err)) return `Adım ${n}: ${step.timeoutLabel} (zaman aşımı)`;
  if (isMissing(err)) return `Adım ${n}: ${step.missingLabel}`;
  return `Adım ${n}: ${step.genericLabel}`;
}

function blockerKindOf(step, err) {
  if (err?.blockerKind === "geo" || err?.code === "geo") return "geo";
  if (err?.blockerKind === "credentials") return "credentials";
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

async function selectorVisible(root, selector) {
  try {
    return await root.locator(selector).first().isVisible();
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

async function anyVisible(root, selectors) {
  for (const selector of selectors) {
    if (await selectorVisible(root, selector)) return true;
  }
  return false;
}

async function frameHasCaptcha(frame) {
  if (await anyVisible(frame, CAPTCHA_WIDGETS)) return true;
  const prompt = await frame.locator("text=/we would like to make sure you are not a robot|please enter verification code|doğrulama kodu|not a robot/i").first().isVisible().catch(() => false);
  if (!prompt) return false;
  return frame.locator(CAPTCHA_INPUT).first().isVisible().catch(() => false);
}

function safeFrames(page) {
  try {
    if (!pageOpen(page)) return [];
    return page.frames();
  } catch (err) {
    if (isContextDestroyed(err)) return [];
    throw err;
  }
}

async function isCaptchaPage(page) {
  if (!pageOpen(page)) return false;
  for (const frame of safeFrames(page)) {
    if (await frameHasCaptcha(frame).catch(() => false)) return true;
  }
  return false;
}

async function detectCredentials(page) {
  if (!pageOpen(page)) return false;
  if (await selectorVisible(page, SEL.errorText)) return true;
  let sample = "";
  try {
    sample = (await page.locator("body").innerText({ timeout: 1000 })).slice(0, 4000);
  } catch {
    sample = "";
  }
  return CREDENTIAL_RE.test(sample);
}

async function takeScreenshot(page) {
  if (!pageOpen(page)) return null;
  try {
    const buffer = await page.screenshot({ fullPage: false, timeout: PROXY_URL ? 15000 : 8000 });
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

function describeCaptchaMedia() {
  const visible = (el) => {
    if (!el?.getClientRects?.().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const input = [...document.querySelectorAll("input")].find((el) => visible(el) && /verification code|doğrulama kodu|captcha|verify/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`));
  const media = [...document.querySelectorAll("img, canvas")].filter(visible);
  let el = null;
  if (input && media.length) {
    const ir = input.getBoundingClientRect();
    const above = media
      .map((node) => ({ node, r: node.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 16 && r.height > 10 && r.bottom <= ir.top + 12)
      .sort((a, b) => (ir.top - a.r.bottom) - (ir.top - b.r.bottom));
    el = above[0]?.node || null;
  }
  if (!el) el = media.find((node) => /captcha|verify|code/i.test(`${node.getAttribute("src") || ""} ${node.getAttribute("alt") || ""} ${node.id || ""}`)) || null;
  return el;
}

async function captchaMediaState() {
  const visible = (el) => {
    if (!el?.getClientRects?.().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const input = [...document.querySelectorAll("input")].find((el) => visible(el) && /verification code|doğrulama kodu|captcha|verify/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`));
  const media = [...document.querySelectorAll("img, canvas")].filter(visible);
  let el = null;
  if (input && media.length) {
    const ir = input.getBoundingClientRect();
    const above = media
      .map((node) => ({ node, r: node.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 16 && r.height > 10 && r.bottom <= ir.top + 12)
      .sort((a, b) => (ir.top - a.r.bottom) - (ir.top - b.r.bottom));
    el = above[0]?.node || null;
  }
  if (!el) el = media.find((node) => /captcha|verify|code/i.test(`${node.getAttribute("src") || ""} ${node.getAttribute("alt") || ""} ${node.id || ""}`)) || null;
  if (!el) return { found: false, ready: false, blank: true, failed: false, src: "" };
  const src = el.currentSrc || el.getAttribute("src") || "";
  const blankOf = (node) => {
    try {
      const w = node.tagName === "IMG" ? node.naturalWidth : node.width;
      const h = node.tagName === "IMG" ? node.naturalHeight : node.height;
      if (w < 2 || h < 2) return true;
      const canvas = document.createElement("canvas");
      const dw = Math.min(w, 64);
      const dh = Math.min(h, 32);
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(node, 0, 0, dw, dh);
      const data = ctx.getImageData(0, 0, dw, dh).data;
      let colored = 0;
      const total = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 16) continue;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) colored += 1;
      }
      return colored / total < 0.02;
    } catch {
      return false;
    }
  };
  if (el.tagName === "IMG") {
    if (!el.complete) return { found: true, ready: false, blank: true, failed: false, src };
    if (el.naturalWidth <= 0) return { found: true, ready: false, blank: true, failed: true, src };
    if (el.decode) {
      try { await el.decode(); } catch { return { found: true, ready: false, blank: true, failed: false, src }; }
    }
    return { found: true, ready: true, blank: blankOf(el), failed: false, src };
  }
  const ready = el.width > 0 && el.height > 0;
  return { found: true, ready, blank: ready ? blankOf(el) : true, failed: !ready, src };
}

function clickCaptchaRefresh() {
  const visible = (el) => {
    if (!el?.getClientRects?.().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const input = [...document.querySelectorAll("input")].find((el) => visible(el) && /verification code|doğrulama kodu|captcha|verify/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`));
  const media = [...document.querySelectorAll("img, canvas")].filter(visible);
  let img = null;
  if (input && media.length) {
    const ir = input.getBoundingClientRect();
    const above = media
      .map((node) => ({ node, r: node.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 16 && r.height > 10 && r.bottom <= ir.top + 12)
      .sort((a, b) => (ir.top - a.r.bottom) - (ir.top - b.r.bottom));
    img = above[0]?.node || null;
  }
  if (!img) img = media.find((node) => /captcha|verify|code/i.test(`${node.getAttribute("src") || ""} ${node.getAttribute("alt") || ""} ${node.id || ""}`)) || null;
  const refresh = [...document.querySelectorAll("a, button, [role='button'], span, i")].find((el) => {
    if (!visible(el) || el === img) return false;
    const label = `${el.className} ${el.id} ${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""} ${(el.innerText || "").slice(0, 40)}`;
    return /refresh|reload|yenile|换一张|captcha-refresh/i.test(label);
  });
  if (refresh) {
    refresh.click();
    return "link";
  }
  if (img) {
    img.click();
    return "img";
  }
  return "";
}

async function queryCaptchaState(page) {
  if (!pageOpen(page)) return { found: false, ready: false, blank: true, failed: false, src: "", closed: true };
  if (CAPTCHA_IMAGE) {
    try {
      const loc = page.locator(CAPTCHA_IMAGE).first();
      if (await loc.isVisible().catch(() => false)) {
        const state = await loc.evaluate(async (el) => {
          const src = el.currentSrc || el.getAttribute("src") || "";
          if (el.tagName === "IMG") {
            if (!el.complete) return { found: true, ready: false, blank: true, failed: false, src };
            if (el.naturalWidth <= 0) return { found: true, ready: false, blank: true, failed: true, src };
            if (el.decode) {
              try { await el.decode(); } catch { return { found: true, ready: false, blank: true, failed: false, src }; }
            }
          }
          return { found: true, ready: true, blank: false, failed: false, src };
        });
        if (state?.found) return state;
      }
    } catch (err) {
      if (isContextDestroyed(err)) return { found: false, ready: false, blank: true, failed: false, src: "", destroyed: true };
    }
  }
  for (const frame of safeFrames(page)) {
    const state = await frame.evaluate(captchaMediaState).catch((err) => {
      if (isContextDestroyed(err)) return { destroyed: true };
      return null;
    });
    if (state?.destroyed) return { found: false, ready: false, blank: true, failed: false, src: "", destroyed: true };
    if (state?.found) return state;
  }
  return { found: false, ready: false, blank: true, failed: false, src: "" };
}

async function waitForCaptchaPixels(page, timeout) {
  const deadline = Date.now() + timeout;
  let last = { found: false, ready: false, blank: true, failed: false, src: "" };
  while (Date.now() < deadline) {
    last = await queryCaptchaState(page);
    if (last.destroyed) {
      await delay(300);
      continue;
    }
    if (last.ready && !last.blank) {
      await delay(400);
      const again = await queryCaptchaState(page);
      if (again.ready && !again.blank) return again;
      last = again;
    }
    if (last.failed || (last.found && last.ready && last.blank)) return last;
    await delay(250);
  }
  return last;
}

async function refreshCaptcha(page) {
  if (CAPTCHA_IMAGE) {
    const clicked = await page.locator(CAPTCHA_IMAGE).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) return;
  }
  for (const frame of safeFrames(page)) {
    const hit = await frame.evaluate(clickCaptchaRefresh).catch(() => "");
    if (hit) return;
  }
}

async function screenshotCaptcha(page) {
  const shotTimeout = PROXY_URL ? 15000 : 8000;
  if (CAPTCHA_IMAGE) {
    try {
      const loc = page.locator(CAPTCHA_IMAGE).first();
      if (await loc.isVisible().catch(() => false)) return (await loc.screenshot({ timeout: shotTimeout })).toString("base64");
    } catch (err) {
      if (!isContextDestroyed(err)) { /* yerleşim yedeği */ }
    }
  }
  for (const frame of safeFrames(page)) {
    let handle;
    try {
      handle = await frame.evaluateHandle(describeCaptchaMedia);
    } catch {
      continue;
    }
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => {});
      continue;
    }
    try {
      return (await el.screenshot({ timeout: shotTimeout })).toString("base64");
    } catch {
      await el.dispose().catch(() => {});
    }
  }
  return null;
}

// Kod çözülmez. Görsel tam yüklenmeden ekran görüntüsü alınmaz.
async function captureCaptchaImage(page) {
  if (!pageOpen(page)) return null;
  let state = await waitForCaptchaPixels(page, TIMEOUTS.captcha).catch(() => null);
  if (!state?.ready || state.blank || state.failed) {
    await refreshCaptcha(page).catch(() => {});
    await delay(300);
    state = await waitForCaptchaPixels(page, TIMEOUTS.captcha).catch(() => state);
  }
  return (await screenshotCaptcha(page).catch(() => null)) || (await takeScreenshot(page));
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
      sessionId: ctx.id,
      url: currentUrl(ctx.active),
      message: `Adım ${step.n}: geçici gezinme hatası, bir kez yeniden deneniyor`,
      detail: err?.message,
    });
    if (recover) await withDeadline(recover, PROXY_URL ? 10000 : 3000).catch(() => {});
    return await run();
  }
}

async function replacePage(ctx) {
  await Promise.race([ctx.page?.close().catch(() => {}), delay(1500)]);
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

function acceptLanguage(locale) {
  const clean = String(locale || "de-DE").trim() || "de-DE";
  const base = clean.split("-")[0];
  if (!base || base.toLowerCase() === clean.toLowerCase()) return `${clean},en;q=0.8`;
  return `${clean},${base};q=0.9,en;q=0.8`;
}

function desktopChromeUa(version) {
  const match = String(version || "").match(/\d+\.\d+\.\d+(?:\.\d+)?/);
  const v = match ? match[0] : "131.0.0.0";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

function parseProxyUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("bad-proxy"), { code: "bad-proxy" });
  }
  const allowed = new Set(["http:", "https:", "socks5:", "socks4:"]);
  if (!allowed.has(url.protocol) || !url.hostname) {
    throw Object.assign(new Error("bad-proxy"), { code: "bad-proxy" });
  }
  const proxy = { server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}` };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

async function launchChromium() {
  const proxy = parseProxyUrl(PROXY_URL);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(proxy ? ["--proxy-bypass-list=<-loopback>"] : [])],
    ...(proxy ? { proxy } : {}),
  });
  const language = acceptLanguage(BROWSER_LOCALE);
  const context = await browser.newContext({
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TZ,
    userAgent: BROWSER_UA || desktopChromeUa(browser.version()),
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": language },
  });
  // Chromium, locale yüzünden Accept-Language'i tek etikete indirir. İsteklerde tam listeyi geri yazarız.
  await context.route("**/*", async (route) => {
    const headers = { ...route.request().headers(), "accept-language": language };
    await route.continue({ headers });
  });
  return { browser, context };
}

async function isGeoBlocked(page) {
  if (!pageOpen(page)) return false;
  try {
    const text = await page.locator("body").innerText({ timeout: 2000 });
    return GEO_TEXT.test(text);
  } catch {
    return false;
  }
}

function findCjInDocument() {
  const textOf = (el) => {
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute?.("class") || "");
    return [el.getAttribute?.("src"), el.getAttribute?.("href"), el.getAttribute?.("alt"), el.getAttribute?.("aria-label"), el.getAttribute?.("title"), cls].filter(Boolean).join(" ");
  };
  const visible = (el) => {
    if (!el?.getClientRects?.().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const nodes = [...document.querySelectorAll("img, svg, i, span, a, button, [role='button']")];
  const wa = nodes.find((el) => visible(el) && /whatsapp/i.test(textOf(el)));
  const clickable = (el) => {
    const host = el.closest?.("a, button, [role='button']");
    if (!host) return el;
    if (wa && host.contains(wa) && host !== el) return el;
    return host;
  };
  if (wa) {
    let row = wa.parentElement;
    for (let i = 0; i < 6 && row; i += 1) {
      const icons = [...row.querySelectorAll("img, svg")].filter(visible);
      if (icons.length >= 4) break;
      row = row.parentElement;
    }
    const wr = wa.getBoundingClientRect();
    const left = [...(row?.querySelectorAll("a, button, img, svg, span, i") || [])]
      .filter((el) => visible(el) && el !== wa && !el.contains(wa))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 8 && r.height > 8 && r.right <= wr.left + 8)
      .filter(({ r }) => Math.abs((r.top + r.bottom) / 2 - (wr.top + wr.bottom) / 2) < Math.max(48, wr.height * 1.5))
      .sort((a, b) => a.r.left - b.r.left);
    const marked = left.find(({ el }) => /cj/i.test(textOf(el)));
    const chosen = (marked || left[0])?.el;
    if (chosen) return clickable(chosen);
  }
  const cj = nodes.find((el) => visible(el) && /cj/i.test(textOf(el)) && !/whatsapp/i.test(textOf(el)));
  return cj ? clickable(cj) : null;
}

async function findCj(page) {
  for (const frame of safeFrames(page)) {
    let handle;
    try {
      handle = await frame.evaluateHandle(findCjInDocument);
    } catch {
      continue;
    }
    const el = handle.asElement();
    if (el) return el;
    await handle.dispose().catch(() => {});
  }
  return null;
}

async function positionAgainstWhatsapp(el) {
  return el.evaluate((node) => {
    const textOf = (item) => {
      const cls = typeof item.className === "string" ? item.className : (item.getAttribute?.("class") || "");
      return [item.getAttribute?.("src"), item.getAttribute?.("href"), item.getAttribute?.("alt"), item.getAttribute?.("aria-label"), item.getAttribute?.("title"), cls].filter(Boolean).join(" ");
    };
    const visible = (item) => {
      if (!item?.getClientRects?.().length) return false;
      const s = getComputedStyle(item);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
    };
    const wa = [...document.querySelectorAll("img, svg, i, span, a, button")].find((item) => visible(item) && /whatsapp/i.test(textOf(item)));
    if (!wa) return { ok: true, reason: "whatsapp-yok" };
    const wr = wa.getBoundingClientRect();
    const er = node.getBoundingClientRect();
    const sameRow = Math.abs((er.top + er.bottom) / 2 - (wr.top + wr.bottom) / 2) < Math.max(48, wr.height * 1.5);
    const left = er.right <= wr.left + 8;
    return { ok: sameRow && left, left: Math.round(er.left), wa: Math.round(wr.left), sameRow };
  });
}

function isCjUrl(url) {
  return /cjdropshipping|cj\.com/i.test(String(url || ""));
}

async function describeSurfaces(session) {
  const lines = [];
  const pages = session?.context?.pages?.() || [];
  for (const p of pages) {
    const url = pageOpen(p) ? (currentUrl(p) || "(boş)") : "(kapalı)";
    lines.push(`${p === session.page ? "ana" : "pencere"}: ${url}`);
    for (const frame of safeFrames(p)) {
      let frameUrl = "";
      try { frameUrl = frame.url(); } catch { continue; }
      if (frameUrl && frameUrl !== url) lines.push(`çerçeve: ${frameUrl}`);
    }
  }
  return lines.length ? lines.join(" | ") : "açık sayfa yok";
}

async function collectPageShots(session) {
  const shots = [];
  const pages = session?.context?.pages?.() || [];
  for (const p of pages) {
    if (!pageOpen(p) || shots.length >= 4) continue;
    const url = currentUrl(p);
    const image = await takeScreenshot(p);
    if (image) shots.push({ url, image });
  }
  return shots;
}

function startCjWatch(session, timeout) {
  const page = session.page;
  const startUrl = page.url();
  const seen = { popup: null };
  const popupWait = session.context.waitForEvent("page", { timeout }).then((popup) => {
    seen.popup = popup;
    return popup;
  }).catch(() => null);
  const urlWait = page.waitForURL(/cjdropshipping/i, { timeout, waitUntil: "domcontentloaded" }).then(() => true).catch(() => false);
  return (async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const popup = seen.popup;
      if (popup && pageOpen(popup)) {
        const popupUrl = currentUrl(popup) || "";
        if (popupUrl && popupUrl !== "about:blank") return { kind: "popup", page: popup };
      }
      for (const candidate of session.context.pages()) {
        if (candidate === page || !pageOpen(candidate)) continue;
        const candidateUrl = currentUrl(candidate) || "";
        if (isCjUrl(candidateUrl) || (candidateUrl && candidateUrl !== "about:blank")) return { kind: "popup", page: candidate };
      }
      const mainUrl = currentUrl(page) || "";
      if (isCjUrl(mainUrl) || (pathOf(mainUrl) && pathOf(mainUrl) !== pathOf(startUrl))) return { kind: "redirect", page };
      for (const frame of safeFrames(page)) {
        if (frame === page.mainFrame()) continue;
        let frameUrl = "";
        try { frameUrl = frame.url(); } catch { continue; }
        if (!frameUrl || frameUrl === "about:blank") continue;
        if (isCjUrl(frameUrl) || /cjdropshipping/i.test(frameUrl)) return { kind: "frame", frame, page };
        const emailVisible = await frame.locator(SEL.cjEmail).first().isVisible().catch(() => false);
        if (emailVisible) return { kind: "frame", frame, page };
      }
      await delay(250);
    }
    await popupWait;
    await urlWait;
    if (seen.popup && pageOpen(seen.popup)) return { kind: "popup", page: seen.popup };
    return null;
  })();
}

async function loginRoots(session) {
  const roots = [];
  const pushPage = (p) => {
    if (!pageOpen(p)) return;
    for (const frame of safeFrames(p)) roots.push(frame);
  };
  if (session.loginFrame) roots.push(session.loginFrame);
  if (session.cjKind === "popup") pushPage(session.popup || session.active);
  else if (session.cjKind === "frame") pushPage(session.page);
  else pushPage(session.active || session.page);
  return roots;
}

async function loginLocator(session, selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isCaptchaPage(session.active || session.page).catch(() => false)) {
      const pause = new Error("captcha");
      pause.captchaPause = true;
      throw pause;
    }
    for (const root of await loginRoots(session)) {
      const loc = root.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await delay(300);
  }
  const surfaces = await describeSurfaces(session);
  const err = new Error(`Timeout ${timeout}ms exceeded waiting for ${selector}. ${surfaces}`);
  err.name = "TimeoutError";
  err.surfaces = surfaces;
  throw err;
}

function publicDetail(err) {
  const raw = String(err?.message || "");
  if (!raw || raw.length < 12) return null;
  if (/^(geo|bad-proxy|bad-url|no-redirect|missing-button|credentials|expired|captcha)$/i.test(raw)) return null;
  return redact(raw, 500);
}

async function runStep(ctx, step, fn) {
  ctx.currentStep = step;
  log({
    level: "info",
    step: step.id,
    stepNo: step.n,
    stepName: step.name,
    event: "start",
    email: ctx.email,
    sessionId: ctx.id,
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
      sessionId: ctx.id,
      url: currentUrl(ctx.active),
      message: `Adım ${step.n} tamam: ${step.name}`,
    });
  } catch (err) {
    if (err?.captchaPause) {
      if (!err.image) err.image = await captureCaptchaImage(ctx.active || ctx.page).catch(() => null);
      log({
        level: "info",
        step: "captcha",
        event: "pause",
        email: ctx.email,
        sessionId: ctx.id,
        url: currentUrl(ctx.active),
        message: "Doğrulama kodu bekleniyor",
      });
      throw err;
    }
    if (err?.handled) throw err;
    if (await isCaptchaPage(ctx.active || ctx.page).catch(() => false)) {
      const pause = new Error("captcha");
      pause.captchaPause = true;
      pause.image = await captureCaptchaImage(ctx.active || ctx.page).catch(() => null);
      log({
        level: "info",
        step: "captcha",
        event: "pause",
        email: ctx.email,
        sessionId: ctx.id,
        url: currentUrl(ctx.active),
        message: "Doğrulama kodu bekleniyor",
      });
      throw pause;
    }
    let credentials = false;
    if (step.n >= STEPS.submit.n) credentials = await detectCredentials(ctx.active).catch(() => false);
    if (credentials) err.blockerKind = "credentials";
    const message = messageFor(step, err);
    const url = currentUrl(ctx.active) || currentUrl(ctx.page);
    const surfaces = await describeSurfaces(ctx).catch(() => "");
    const shots = await collectPageShots(ctx).catch(() => []);
    const screenshot = shots.find((shot) => shot.image)?.image || null;
    const kind = blockerKindOf(step, err);
    const detailText = [publicDetail(err), surfaces].filter(Boolean).join(" | ");
    log({
      level: "error",
      step: step.id,
      stepNo: step.n,
      stepName: step.name,
      event: "fail",
      email: ctx.email,
      sessionId: ctx.id,
      url,
      message,
      detail: detailText || err?.message,
      blocker: kind,
    });
    const wrapped = new Error(message);
    wrapped.handled = true;
    wrapped.stepId = step.id;
    wrapped.stepNo = step.n;
    wrapped.url = url ? redact(url, 500) : null;
    wrapped.screenshot = screenshot;
    wrapped.screenshots = shots;
    wrapped.blocker = kind;
    wrapped.detail = detailText || null;
    throw wrapped;
  }
}

function armTimeout(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    log({
      level: "warn",
      step: "session",
      event: "expire",
      email: session.email,
      sessionId: session.id,
      message: "Oturum zaman aşımı, tarayıcı kapatılıyor",
    });
    void closeSession(session.id);
  }, SESSION_TTL);
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session || session.closing) return;
  session.closing = true;
  clearTimeout(session.timer);
  sessions.delete(id);
  if (activeSessionId === id) activeSessionId = null;
  session.password = "";
  const browser = session.browser;
  session.browser = null;
  await closeBrowser(browser);
}

function captchaResult(session, image) {
  armTimeout(session);
  log({
    level: "info",
    step: "captcha",
    event: "pause",
    email: session.email,
    sessionId: session.id,
    url: currentUrl(session.active),
    message: "Doğrulama kodu bekleniyor",
  });
  return { status: "captcha", sessionId: session.id, image };
}

async function drive(session) {
  while (session.phaseIndex < PHASES.length) {
    if (session.closing) throw Object.assign(new Error("expired"), { code: "expired" });
    const page = pageOpen(session.active) ? session.active : session.page;
    session.active = page;
    const key = PHASES[session.phaseIndex];
    if (key === "cjButton") {
      await runStep(session, STEPS.geo, async () => {
        if (await isGeoBlocked(session.page)) throw Object.assign(new Error("geo"), { code: "geo", blockerKind: "geo" });
      });
      session.currentStep = STEPS.captcha;
    }
    let captchaNow = false;
    try {
      captchaNow = await isCaptchaPage(page);
    } catch (err) {
      if (!isContextDestroyed(err)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch(() => {});
      continue;
    }
    if (captchaNow) {
      return captchaResult(session, await captureCaptchaImage(page));
    }
    try {
      await runStep(session, STEPS[key], () => STEP_FNS[key](session));
    } catch (err) {
      if (err?.captchaPause) return captchaResult(session, err.image || await captureCaptchaImage(page).catch(() => null));
      if (isContextDestroyed(err) && !err.handled) {
        await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch(() => {});
        continue;
      }
      throw err;
    }
    session.phaseIndex += 1;
  }
  const url = currentUrl(session.page) || currentUrl(session.active);
  log({
    level: "info",
    step: "onboard",
    event: "done",
    email: session.email,
    sessionId: session.id,
    url,
    message: "CJ bağlantısı tamamlandı",
  });
  return { ok: true, status: "ok", url: url ? redact(url, 500) : null };
}

const STEP_FNS = {
  async cjButton(session) {
    const page = session.page;
    if (CJ_BUTTON_OVERRIDE) {
      const btn = page.locator(CJ_BUTTON_OVERRIDE).first();
      try {
        await btn.waitFor({ state: "visible", timeout: TIMEOUTS.cjButton });
      } catch (err) {
        if (isTimeout(err) || isMissing(err)) err.code = "missing-button";
        throw err;
      }
      session.cjClick = () => btn.click({ timeout: TIMEOUTS.cjButton, noWaitAfter: true });
      return;
    }
    const deadline = Date.now() + TIMEOUTS.cjButton;
    let el = null;
    while (Date.now() < deadline) {
      el = await findCj(page);
      if (el) break;
      await delay(200);
    }
    if (!el) throw Object.assign(new Error("missing-button"), { code: "missing-button" });
    const position = await positionAgainstWhatsapp(el).catch(() => ({ ok: true, reason: "whatsapp-yok" }));
    if (position && position.ok === false) {
      await el.dispose().catch(() => {});
      throw Object.assign(new Error("not-left"), { code: "not-left", position: `ikon x=${position.left}, WhatsApp x=${position.wa}` });
    }
    session.cjClick = async () => {
      try {
        await el.click({ timeout: TIMEOUTS.cjButton, noWaitAfter: true });
      } finally {
        await el.dispose().catch(() => {});
      }
    };
  },
  async popup(session) {
    const timeout = Math.max(TIMEOUTS.popup, TIMEOUTS.navigation);
    const watch = startCjWatch(session, timeout);
    let target = null;
    const clickTask = Promise.resolve().then(() => session.cjClick?.()).catch((err) => {
      if (isContextDestroyed(err)) return null;
      throw err;
    });
    try {
      [target] = await Promise.all([watch, clickTask]);
    } catch (err) {
      target = await Promise.race([watch, delay(1500).then(() => null)]);
      if (!target) throw err;
    }
    if (!target) {
      throw Object.assign(new Error("no-redirect"), { code: "no-redirect", surfaces: await describeSurfaces(session) });
    }
    session.cjKind = target.kind;
    if (target.kind === "popup") {
      session.popup = target.page;
      session.active = target.page;
      await target.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch((err) => {
        if (!isContextDestroyed(err) && !isTimeout(err)) throw err;
      });
    } else if (target.kind === "frame") {
      session.loginFrame = target.frame;
      session.active = target.page;
    } else {
      session.active = target.page;
      await target.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch(() => {});
    }
    log({
      level: "info",
      step: STEPS.popup.id,
      stepNo: STEPS.popup.n,
      stepName: STEPS.popup.name,
      event: target.kind,
      email: session.email,
      sessionId: session.id,
      url: target.kind === "frame" ? target.frame.url() : currentUrl(target.page),
      message: target.kind === "popup" ? "CJ penceresi açıldı" : target.kind === "frame" ? "CJ çerçevesi bulundu" : "CJ sayfasına geçildi",
    });
  },
  async email(session) {
    const field = await loginLocator(session, SEL.cjEmail, TIMEOUTS.email);
    await field.fill(session.email, { timeout: TIMEOUTS.email });
  },
  async password(session) {
    const field = await loginLocator(session, SEL.cjPassword, TIMEOUTS.password);
    await field.fill(session.password, { timeout: TIMEOUTS.password });
  },
  async submit(session) {
    const button = await loginLocator(session, SEL.cjSubmit, TIMEOUTS.submit);
    try {
      await button.click({ timeout: TIMEOUTS.submit, noWaitAfter: true });
    } catch (err) {
      if (!isContextDestroyed(err)) throw err;
    }
    const page = pageOpen(session.active) ? session.active : session.page;
    if (pageOpen(page)) {
      await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.submit }).catch(() => {});
      await delay(300);
    }
    if (await detectCredentials(page)) throw blockerError("credentials");
  },
  async authorize(session) {
    if (!pageOpen(session.active)) session.active = session.page;
    if (pageOpen(session.active) || session.popup) {
      const deadline = Date.now() + TIMEOUTS.authorize;
      let auth = null;
      while (!auth && Date.now() < deadline) {
        for (const candidate of session.context?.pages?.() || []) {
          for (const frame of safeFrames(candidate)) {
            const loc = frame.locator(SEL.cjAuthorize).first();
            if (await loc.isVisible().catch(() => false)) {
              auth = loc;
              break;
            }
          }
          if (auth) break;
        }
        if (!auth) await delay(250);
      }
      if (auth) await auth.click({ timeout: TIMEOUTS.authorize, noWaitAfter: true }).catch((err) => {
        if (!isContextDestroyed(err)) throw err;
      });
      else {
        log({
          level: "info",
          step: STEPS.authorize.id,
          stepNo: STEPS.authorize.n,
          stepName: STEPS.authorize.name,
          event: "skip",
          email: session.email,
          sessionId: session.id,
          url: currentUrl(session.active),
          message: "Yetki ekranı görünmedi, adım atlandı",
        });
      }
    }
    if (session.popup && pageOpen(session.popup)) {
      await session.popup.waitForEvent("close", { timeout: TIMEOUTS.authorize }).catch(() => {});
    }
    if (pageOpen(session.page)) session.active = session.page;
    if (await detectCredentials(session.active)) throw blockerError("credentials");
  },
  async success(session) {
    const page = pageOpen(session.page) ? session.page : session.active;
    session.active = page;
    const success = page.locator(SEL.successCheck).first();
    const deadline = Date.now() + TIMEOUTS.success;
    const successVisible = async () => {
      try {
        return await success.isVisible();
      } catch (err) {
        if (isBadSelector(err)) throw err;
        return false;
      }
    };
    while (Date.now() < deadline) {
      if (await isCaptchaPage(page)) {
        const pause = new Error("captcha");
        pause.captchaPause = true;
        throw pause;
      }
      if (await successVisible()) return;
      if (await detectCredentials(page)) throw blockerError("credentials");
      await delay(Math.min(400, Math.max(0, deadline - Date.now())));
    }
    if (await successVisible()) return;
    if (await isCaptchaPage(page)) {
      const pause = new Error("captcha");
      pause.captchaPause = true;
      throw pause;
    }
    if (await detectCredentials(page)) throw blockerError("credentials");
    throw Object.assign(new Error("Timeout exceeded while waiting for success"), { name: "TimeoutError" });
  },
};

async function openRegister(session) {
  await runStep(session, STEPS.browser, async () => {
    const launched = await launchChromium();
    session.browser = launched.browser;
    session.context = launched.context;
    session.page = await session.context.newPage();
    session.active = session.page;
  });
  await runStep(session, STEPS.openLogin, async () => {
    if (!isHttpUrl(SEL.loginUrl)) throw Object.assign(new Error("bad-url"), { code: "bad-url" });
    await withNavRetry(session, STEPS.openLogin, () => session.page.goto(SEL.loginUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.openLogin }), {
      recover: () => replacePage(session),
      timeoutMs: TIMEOUTS.openLogin,
    });
  });
}

function isRegisterPath(url) {
  try {
    return /\/register\.html\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isValidationPath(url) {
  try {
    return /\/validation\.html\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function captchaErrorVisible(page) {
  if (!pageOpen(page)) return false;
  for (const frame of safeFrames(page)) {
    const hit = await frame.locator("text=/incorrect code|invalid code|wrong code|verification failed|code is incorrect|验证码错误|doğrulama kodu hatalı|yanlış kod/i").first().isVisible().catch(() => false);
    if (hit) return true;
  }
  return false;
}

function pathOf(url) {
  try {
    return new URL(url).pathname || "";
  } catch {
    return "";
  }
}

async function leftCaptcha(page, url, startUrl) {
  if (isRegisterPath(url)) return true;
  if (!url || pathOf(url) === pathOf(startUrl) || isValidationPath(url)) return false;
  return !(await isCaptchaPage(page).catch(() => true));
}

async function settleAfterCaptchaSubmit(page, beforeSrc, startUrl, hadError) {
  const timeout = TIMEOUTS.captcha;
  let stop = false;
  let sawReload = false;
  const registerWait = page.waitForURL(
    (url) => /\/register\.html\/?$/i.test(url.pathname),
    { timeout, waitUntil: "domcontentloaded" },
  ).then(() => "register").catch((err) => (isContextDestroyed(err) ? "destroyed" : "register-timeout"));
  const changeWait = (async () => {
    const deadline = Date.now() + timeout;
    while (!stop && Date.now() < deadline) {
      let url = "";
      try {
        url = page.url();
      } catch (err) {
        if (!isContextDestroyed(err)) throw err;
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(8000, Math.max(500, deadline - Date.now())) }).catch(() => {});
        await delay(300);
        continue;
      }
      if (await leftCaptcha(page, url, startUrl)) return "register";
      if (!hadError && await captchaErrorVisible(page).catch((err) => {
        if (isContextDestroyed(err)) return false;
        throw err;
      })) return "captcha";
      const marker = await queryCaptchaState(page).catch((err) => (isContextDestroyed(err) ? { destroyed: true } : null));
      if (marker?.destroyed) {
        await delay(300);
        continue;
      }
      const samePage = pathOf(url) === pathOf(startUrl);
      if (samePage && beforeSrc && marker?.src && marker.src !== beforeSrc && (marker.ready || marker.failed)) return "captcha";
      if (samePage && marker?.found && !marker.ready && !marker.failed) sawReload = true;
      if (samePage && sawReload && marker?.ready) return "captcha";
      await delay(300);
    }
    return "timeout";
  })();
  let winner;
  try {
    winner = await Promise.race([registerWait, changeWait]);
  } finally {
    stop = true;
  }
  if (winner === "register") {
    await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch((err) => {
      if (!isContextDestroyed(err) && !isTimeout(err)) throw err;
    });
    return "register";
  }
  if (winner === "captcha") return "captcha";
  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(TIMEOUTS.navigation, 15000) }).catch(() => {});
  const url = currentUrl(page) || "";
  if (await leftCaptcha(page, url, startUrl)) return "register";
  if (isValidationPath(url) || pathOf(url) === pathOf(startUrl) || await isCaptchaPage(page).catch(() => false)) return "captcha";
  throw Object.assign(new Error(`Timeout exceeded while waiting after captcha submit (${url || "url yok"})`), { name: "TimeoutError" });
}

async function submitCaptchaCode(session, code) {
  const page = pageOpen(session.active) ? session.active : session.page;
  session.active = page;
  session.currentStep = STEPS.captcha;
  if (!(await isCaptchaPage(page).catch(() => false))) return drive(session);
  let outcome = "register";
  await runStep(session, STEPS.captcha, async () => {
    const before = await queryCaptchaState(page).catch(() => ({ src: "" }));
    const hadError = await captchaErrorVisible(page).catch(() => false);
    const startUrl = currentUrl(page) || page.url();
    const input = page.locator(CAPTCHA_INPUT).first();
    await input.waitFor({ state: "visible", timeout: TIMEOUTS.captcha });
    await input.fill(String(code), { timeout: TIMEOUTS.captcha });
    try {
      await page.locator(CAPTCHA_SUBMIT).first().click({ timeout: TIMEOUTS.captcha, noWaitAfter: true });
    } catch (err) {
      if (!isContextDestroyed(err)) throw err;
    }
    outcome = await settleAfterCaptchaSubmit(page, before?.src || "", startUrl, hadError);
  });
  if (outcome === "captcha") return captchaResult(session, await captureCaptchaImage(page));
  return drive(session);
}

async function attachFailureShot(err, session) {
  if (!err || typeof err !== "object" || err.screenshot) return err;
  const shot = await withDeadline(
    async () => (await takeScreenshot(session?.active)) || (await takeScreenshot(session?.page)),
    PROXY_URL ? 20000 : 8000,
  ).catch(() => null);
  if (shot) err.screenshot = shot;
  return err;
}

function failureBody(err, session) {
  const liveUrl = currentUrl(session?.active) || currentUrl(session?.page);
  const safeUrl = (err?.url ?? liveUrl) ? redact(err?.url ?? liveUrl, 500) : null;
  const shot = err?.screenshot ?? null;
  if (err?.code === "expired" || session?.closing) {
    return { ok: false, status: "error", error: "Oturum bulunamadı veya süresi doldu", step: "session", url: null, screenshot: shot, blocker: null, detail: null };
  }
  const screenshots = Array.isArray(err?.screenshots) && err.screenshots.length
    ? err.screenshots
    : (shot ? [{ url: safeUrl, image: shot }] : []);
  if (err?.handled) {
    return {
      ok: false,
      status: "error",
      error: redact(err.message, 1500),
      step: err.stepId,
      url: safeUrl,
      screenshot: screenshots[0]?.image || shot,
      screenshots,
      blocker: err.blocker ?? null,
      detail: err.detail ? redact(err.detail, 1500) : null,
    };
  }
  const step = session?.currentStep;
  const detail = redact(err?.message || "bilinmeyen hata", 500);
  const error = step ? `Adım ${step.n}: ${step.name}: ${detail}` : `Otomasyon: ${detail}`;
  return {
    ok: false,
    status: "error",
    error,
    step: step?.id || "onboard",
    url: safeUrl,
    screenshot: screenshots[0]?.image || shot,
    screenshots,
    blocker: null,
    detail,
  };
}

async function withSessionSecrets(session, code, fn) {
  const secrets = [];
  if (session?.password) secrets.push(String(session.password));
  if (code && String(code).length >= 4) secrets.push(String(code));
  activeSecrets = secrets;
  try {
    return await fn();
  } finally {
    activeSecrets = [];
  }
}

const configured = ["QK_LOGIN_URL", "SEL_LOGIN_URL", "SEL_CJ_BUTTON", "SEL_CJ_EMAIL", "SEL_CJ_PASSWORD", "SEL_CJ_SUBMIT", "SEL_CJ_AUTHORIZE", "SEL_SUCCESS", "SEL_ERROR_TEXT", "SEL_CAPTCHA", "SEL_CAPTCHA_INPUT", "SEL_CAPTCHA_SUBMIT", "SEL_CAPTCHA_IMAGE", "BROWSER_LOCALE", "BROWSER_TZ", "BROWSER_UA", "PROXY_URL", "TIMEOUT_OPEN_LOGIN", "TIMEOUT_CAPTCHA", "TIMEOUT_CJ_BUTTON", "TIMEOUT_POPUP", "TIMEOUT_NAVIGATION", "TIMEOUT_EMAIL", "TIMEOUT_PASSWORD", "TIMEOUT_SUBMIT", "TIMEOUT_AUTHORIZE", "TIMEOUT_SUCCESS", "SESSION_TTL_MS"]
  .filter((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");
log({ level: "info", step: "config", event: "env", message: configured.length ? `Ayarlı ortam değişkenleri: ${configured.join(", ")}` : "Seçici ve zaman aşımı varsayılanları kullanılıyor" });
log({ level: "info", step: "config", event: "timeouts", message: `Zaman aşımları ms: açık=${TIMEOUTS.openLogin}, captcha=${TIMEOUTS.captcha}, cj=${TIMEOUTS.cjButton}, proxy=${PROXY_URL ? "var" : "yok"}` });

const app = express();
app.use(express.json({ limit: "100kb" }));

let debugRunning = false;

app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain; charset=utf-8").send("ok");
});

app.get("/debug/ip", async (_req, res) => {
  if (sessions.size > 0 || debugRunning) {
    return res.status(429).json({ ok: false, error: "Başka bir işlem sürüyor, biraz sonra deneyin" });
  }
  debugRunning = true;
  let browser = null;
  try {
    const body = await withSessionSecrets(null, null, async () => {
      const launched = await launchChromium();
      browser = launched.browser;
      const response = await launched.context.request.get("https://ipapi.co/json", {
        timeout: TIMEOUTS.navigation,
        headers: { "Accept-Language": acceptLanguage(BROWSER_LOCALE) },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok() || !data || data.error || !data.ip) {
        const reason = data?.reason || data?.message || `HTTP ${response.status()}`;
        throw Object.assign(new Error(String(reason)), { code: "ip-lookup" });
      }
      return {
        ip: data.ip,
        country: data.country_name || data.country || null,
        countryCode: data.country || null,
      };
    });
    res.json(body);
  } catch (err) {
    const message = err?.code === "bad-proxy" ? "PROXY_URL geçersiz" : "IP sorgusu başarısız";
    log({
      level: "error",
      step: "debug-ip",
      event: "fail",
      message,
      detail: err?.message,
    });
    res.status(err?.code === "bad-proxy" ? 400 : 502).json({ ok: false, error: message });
  } finally {
    debugRunning = false;
    await closeBrowser(browser);
  }
});

app.post("/onboard", async (req, res) => {
  const { cjEmail, cjPassword } = req.body || {};
  if (typeof cjEmail !== "string" || typeof cjPassword !== "string" || cjEmail.length === 0 || cjPassword.length === 0) {
    return res.status(400).json({ ok: false, status: "error", error: "CJ e-posta ve şifre gerekli" });
  }
  if (sessions.size > 0 || debugRunning) {
    log({ level: "warn", step: "onboard", event: "busy", email: cjEmail, message: "Başka bir işlem sürüyor" });
    return res.status(429).json({ ok: false, status: "error", error: "Başka bir işlem sürüyor, biraz sonra deneyin" });
  }
  const session = {
    id: randomUUID(),
    email: String(cjEmail),
    password: String(cjPassword),
    browser: null,
    context: null,
    page: null,
    active: null,
    popup: null,
    pendingPopup: null,
    phaseIndex: 0,
    timer: null,
    closing: false,
  };
  sessions.set(session.id, session);
  activeSessionId = session.id;
  armTimeout(session);
  log({ level: "info", step: "onboard", event: "start", email: session.email, sessionId: session.id, message: "Onboard başladı" });
  try {
    const result = await withSessionSecrets(session, null, async () => {
      await openRegister(session);
      return drive(session);
    });
    if (result.status !== "captcha") await closeSession(session.id);
    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err ?? "bilinmeyen hata"));
    await attachFailureShot(error, session);
    const body = failureBody(error, session);
    log({
      level: "error",
      step: body.step || "onboard",
      event: "fail",
      email: session.email,
      sessionId: session.id,
      message: body.error,
      detail: body.detail || error.message,
    });
    await closeSession(session.id);
    res.status(error.handled ? 200 : 500).json(body);
  }
});

app.post("/onboard/:sessionId/captcha", async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_ID_RE.test(sessionId)) {
    return res.status(404).json({ ok: false, status: "error", error: "Oturum bulunamadı veya süresi doldu" });
  }
  const session = sessions.get(sessionId);
  if (!session || session.closing) {
    return res.status(404).json({ ok: false, status: "error", error: "Oturum bulunamadı veya süresi doldu" });
  }
  const code = req.body?.code;
  if (typeof code !== "string" || code.trim().length === 0 || code.length > 64) {
    return res.status(400).json({ ok: false, status: "error", error: "Doğrulama kodu gerekli" });
  }
  if (session.busy) {
    return res.status(429).json({ ok: false, status: "error", error: "Başka bir işlem sürüyor, biraz sonra deneyin" });
  }
  session.busy = true;
  armTimeout(session);
  try {
    const result = await withSessionSecrets(session, code, () => submitCaptchaCode(session, code.trim()));
    if (result.status !== "captcha") await closeSession(session.id);
    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err ?? "bilinmeyen hata"));
    await attachFailureShot(error, session);
    const body = failureBody(error, session);
    log({
      level: "error",
      step: body.step || "captcha",
      event: "fail",
      email: session.email,
      sessionId: session.id,
      message: body.error,
      detail: body.detail || error.message,
    });
    await closeSession(session.id);
    res.status(error.handled ? 200 : 500).json(body);
  } finally {
    if (sessions.has(sessionId)) session.busy = false;
  }
});

app.get("/", (_req, res) => res.type("html").send(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Qksource Hesap Açma</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;display:flex;justify-content:center;padding:40px}
.c{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001;width:100%;max-width:440px}
label{display:block;margin:14px 0 6px;font-weight:600}input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:16px;cursor:pointer}
button.black{background:#111}button:disabled{background:#94a3b8}#r{margin-top:20px;word-break:break-all}.ok{color:#15803d}.err{color:#b91c1c}
img{max-width:100%;margin-top:10px;border:1px solid #ddd}#cap[hidden]{display:none}#cap img{display:block;margin:12px auto;background:#fff}
.hint{color:#64748b;font-size:14px;margin-top:8px}</style></head>
<body><div class="c"><h2>Qksource – CJ ile Hesap Aç</h2><form id="f">
<label>CJ e-posta / kullanıcı adı</label><input name="cjEmail" required autocomplete="off">
<label>CJ şifre</label><input name="cjPassword" type="password" required autocomplete="new-password">
<button id="b">Başlat</button></form>
<div id="cap" hidden><p><strong>Doğrulama kodu</strong></p><p class="hint">Resimdeki kodu yazın. Büyük/küçük harf fark etmeyebilir. Yanlışsa yeni resim gelir.</p>
<img id="capimg" alt="Doğrulama kodu"><label for="code">Kod</label><input id="code" autocomplete="off" placeholder="Please enter verification code">
<button id="send" class="black" type="button">Gönder</button></div>
<div id="r"></div></div>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),r=document.getElementById('r');
const cap=document.getElementById('cap'),capimg=document.getElementById('capimg'),code=document.getElementById('code'),send=document.getElementById('send');
let sessionId=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function show(j){
  if(j&&j.status==='captcha'){sessionId=j.sessionId;cap.hidden=false;capimg.src='data:image/png;base64,'+String(j.image||'').replace(/[^A-Za-z0-9+/=]/g,'');code.value='';code.focus();
    r.innerHTML='<p class="hint">Oturum açık. Kodu gönderin.</p>';return;}
  cap.hidden=true;sessionId=null;
  if(j&&j.ok){r.innerHTML='<p class="ok">✅ Başarılı</p><p>Son URL: '+esc(j.url)+'</p>';}
  else{var detail=(j&&j.detail&&j.detail!==j.error)?'<p>'+esc(j.detail)+'</p>':'';var shots=(j&&j.screenshots)||[];if(!shots.length&&j&&j.screenshot)shots=[{url:j.url,image:j.screenshot}];var imgs=shots.filter(function(s){return s&&s.image;}).map(function(s){return '<p>'+esc(s.url||'sayfa')+'</p><img alt="Sayfa" src="data:image/png;base64,'+String(s.image).replace(/[^A-Za-z0-9+/=]/g,'')+'">';}).join('');r.innerHTML='<p class="err">❌ Hata: '+esc((j&&j.error)||'yanıt yok')+'</p>'+detail+(j&&j.url?'<p>URL: '+esc(j.url)+'</p>':'')+imgs;}
  b.disabled=false;b.textContent='Başlat';
}
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;b.textContent='Çalışıyor...';r.innerHTML='';cap.hidden=true;
try{const d=Object.fromEntries(new FormData(f));f.cjPassword.value='';const x=await fetch('/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
const j=await x.json();show(j);}catch(err){r.innerHTML='<p class="err">❌ '+esc(err.message)+'</p>';b.disabled=false;b.textContent='Başlat';}};
send.onclick=async()=>{if(!sessionId)return;send.disabled=true;
try{const x=await fetch('/onboard/'+encodeURIComponent(sessionId)+'/captcha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value})});
const j=await x.json();show(j);}catch(err){r.innerHTML='<p class="err">❌ '+esc(err.message)+'</p>';}
send.disabled=false;};
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
    status: "error",
    error: code === 400 ? "Geçersiz istek gövdesi" : "Beklenmeyen sunucu hatası",
  });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  const actual = server.address().port;
  log({ level: "info", step: "server", event: "listen", message: `Hazır, port ${actual}` });
});
server.on("error", (err) => fatal("server-error", err));
