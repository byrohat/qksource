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
    message: entry.message == null ? null : redact(entry.message, 9000),
    detail: entry.detail == null ? null : redact(entry.detail, 9000),
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
  : ["iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", ".g-recaptcha", "#captcha"];

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
  if (err?.code === "no-redirect") {
    const hedef = err.popupIntent && !String(err.surfaces || "").includes("popup hedef:") ? `popup hedef: ${err.popupIntent}` : "";
    const extra = [err.surfaces, hedef, formatCjDiag(err.diag), err.trace].filter(Boolean).join(" | ");
    return `Adım ${n}: CJ penceresi veya yönlendirme algılanamadı. ${extra}`.trim();
  }
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

function validationMarkersInDocument() {
  const meta = document.querySelector("meta[name='validation']");
  const verify = document.querySelector("#verifyCode");
  const title = document.title || "";
  return !!(verify || meta || /human verification/i.test(title));
}

function registerFormInDocument() {
  const text = (document.body?.innerText || "").slice(0, 12000);
  if (/Welcome to Qksource/i.test(text)) return true;
  if (/Create a Qksource account/i.test(text)) return true;
  if (/Confirm Password/i.test(text)) return true;
  const visible = (el) => {
    if (!el?.getClientRects?.().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const textOf = (el) => {
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute?.("class") || "");
    return [el.getAttribute?.("src"), el.getAttribute?.("href"), el.getAttribute?.("alt"), el.getAttribute?.("aria-label"), el.getAttribute?.("title"), cls].filter(Boolean).join(" ");
  };
  return [...document.querySelectorAll("img, svg, i, span, a, button")].some((el) => visible(el) && /whatsapp/i.test(textOf(el)));
}

function turnstileWidgetInDocument() {
  return !!document.querySelector(".cf-turnstile, iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], script[src*='turnstile'], script[src*='challenges.cloudflare.com']");
}

function turnstileTokenInDocument() {
  const fields = document.querySelectorAll("input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']");
  for (const field of fields) {
    if (String(field.value || "").trim()) return true;
  }
  return false;
}

async function anyFrame(page, fn) {
  if (!pageOpen(page)) return false;
  for (const frame of safeFrames(page)) {
    const hit = await frame.evaluate(fn).catch(() => false);
    if (hit) return true;
  }
  return false;
}

function turnstileTimeout() {
  return envMs("TIMEOUT_TURNSTILE", 30000);
}

// Turnstile kendi jetonunu yazar. Biz yalnızca bekleriz; jeton üretilmez.
async function waitForTurnstile(page, deadline) {
  const end = deadline || (Date.now() + turnstileTimeout());
  if (Date.now() >= end) return;
  if (!(await anyFrame(page, turnstileWidgetInDocument))) return;
  while (Date.now() < end) {
    if (await anyFrame(page, turnstileTokenInDocument)) return;
    if (!(await anyFrame(page, turnstileWidgetInDocument))) return;
    await delay(400);
  }
}

async function frameHasCaptcha(frame) {
  if (await frame.evaluate(validationMarkersInDocument).catch(() => false)) return true;
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

function shouldAbortRequest(request) {
  const type = request.resourceType();
  if (type === "document") return false;
  const url = request.url();
  if (/challenges\.cloudflare\.com|turnstile/i.test(url)) return false;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const localImage = host === "qksource.com" || host.endsWith(".qksource.com") || host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (type === "image" || type === "media") {
    if (localImage || /captcha|verify/i.test(url)) return false;
    return true;
  }
  if (type === "font") return true;
  if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") return true;
  if (host === "accounts.google.com" && /\/gsi\//i.test(url)) return true;
  if (host === "connect.facebook.net" || host.endsWith(".facebook.net")) return true;
  if (/(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)doubleclick\.net$|(^|\.)hotjar\.com$|(^|\.)segment\.com$|(^|\.)segment\.io$|(^|\.)mixpanel\.com$/.test(host)) return true;
  if (host === "yesourcing.com" || host.endsWith(".yesourcing.com")) return true;
  if ((host === "cjdropshipping.com" || host.endsWith(".cjdropshipping.com")) && /\/backend\/Country\.json/i.test(url)) return true;
  return false;
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
  // Proxy'yi yormamak için captcha ve Turnstile dışındaki üçüncü taraf istekleri kesilir.
  const blockedHosts = new Set();
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (shouldAbortRequest(request)) {
      let host = request.url();
      try { host = new URL(request.url()).hostname; } catch { /* adres olduğu gibi */ }
      if (blockedHosts.size < 12 && !blockedHosts.has(host)) {
        blockedHosts.add(host);
        log({ level: "info", step: "browser", event: "block", message: `Üçüncü taraf istek kesildi: ${host}` });
      }
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    const headers = { ...request.headers(), "accept-language": language };
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
  const validation = document.querySelector("#verifyCode")
    || document.querySelector("meta[name='validation']")
    || /human verification/i.test(document.title || "");
  if (validation) return null;
  const banned = (el) => !el
    || el.id === "verifyCode"
    || !!el.closest?.("#verifyCode, #validation, .validation-page, [data-page='validation']");
  const nodes = [...document.querySelectorAll("img, svg, i, span, a, button, [role='button']")];
  const wa = nodes.find((el) => visible(el) && /whatsapp/i.test(textOf(el)) && !banned(el));
  const clickable = (el) => {
    const host = el.closest?.("a, button, [role='button']");
    if (!host || banned(host)) return el;
    if (wa && host.contains(wa) && host !== el) return el;
    return host;
  };
  if (!wa) return null;
  let row = wa.parentElement;
  let best = row;
  for (let i = 0; i < 6 && row; i += 1) {
    best = row;
    const icons = [...row.querySelectorAll("img, svg")].filter((el) => visible(el) && !banned(el));
    if (icons.length >= 4 || !row.parentElement) break;
    row = row.parentElement;
  }
  row = best;
  const wr = wa.getBoundingClientRect();
  const left = [...(row?.querySelectorAll("a, button, img, svg, span, i") || [])]
    .filter((el) => visible(el) && el !== wa && !el.contains(wa) && !banned(el))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 8 && r.height > 8 && r.right <= wr.left + 8)
    .filter(({ r }) => Math.abs((r.top + r.bottom) / 2 - (wr.top + wr.bottom) / 2) < Math.max(48, wr.height * 1.5))
    .sort((a, b) => a.r.left - b.r.left);
  const marked = left.find(({ el }) => /cj/i.test(textOf(el)));
  const chosen = (marked || left[0])?.el;
  if (!chosen || banned(chosen)) return null;
  const host = clickable(chosen);
  return banned(host) ? null : host;
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
    if (node.id === "verifyCode" || node.closest?.("#verifyCode") || document.querySelector("#verifyCode") || document.querySelector("meta[name='validation']") || /human verification/i.test(document.title || "")) {
      return { ok: false, reason: "verifyCode" };
    }
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

function isChromeError(url) {
  return /^chrome-error:/i.test(String(url || "")) || /chromewebdata/i.test(String(url || ""));
}

const popupIntents = new WeakMap();

function intentOf(popup) {
  return popup ? (popupIntents.get(popup) || "") : "";
}

function notePopupRequest(session, popup, req) {
  if (!popup || popup === session.page) return;
  let frame = null;
  try { frame = req.frame(); } catch { return; }
  try {
    if (frame !== popup.mainFrame()) return;
  } catch { return; }
  let navigation = false;
  try { navigation = req.isNavigationRequest() || req.resourceType() === "document"; } catch { navigation = false; }
  if (!navigation) return;
  const url = req.url();
  if (!/^https?:/i.test(url) || isChromeError(url)) return;
  if (!popupIntents.has(popup)) popupIntents.set(popup, url);
  if (!session.popupIntent) session.popupIntent = url;
}

function cjNavTimeout() {
  const set = typeof process.env.TIMEOUT_CJ_NAVIGATION === "string" && process.env.TIMEOUT_CJ_NAVIGATION.trim();
  if (set) return envMs("TIMEOUT_CJ_NAVIGATION", 45000);
  const proxy = typeof process.env.PROXY_URL === "string" && process.env.PROXY_URL.trim();
  return proxy ? 90000 : 45000;
}

async function describeSurfaces(session) {
  const lines = [];
  const pages = session?.context?.pages?.() || [];
  for (const p of pages) {
    const url = pageOpen(p) ? (currentUrl(p) || "(boş)") : "(kapalı)";
    const intent = intentOf(p) || (p !== session.page ? session.popupIntent : "") || "";
    const hedef = intent && (isChromeError(url) || intent !== url) ? ` | popup hedef: ${intent}` : "";
    lines.push(`${p === session.page ? "ana" : "pencere"}: ${url}${hedef}`);
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

function cjStrategyWait() {
  return envMs("TIMEOUT_CJ_CLICK", 20000);
}

function usableHref(href, base) {
  const raw = String(href || "").trim();
  if (!raw || raw === "#" || raw.startsWith("#") || /^javascript:/i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, base || undefined);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(url.protocol)) return null;
  try {
    const current = new URL(base);
    if (`${url.origin}${url.pathname}${url.search}` === `${current.origin}${current.pathname}${current.search}`) return null;
  } catch {
    // Taban adres yoksa aday yine de kullanılır.
  }
  return url.href;
}

function formatCjDiag(diag) {
  if (!diag || typeof diag !== "object") return "";
  const attrs = diag.attrs && typeof diag.attrs === "object"
    ? Object.entries(diag.attrs).map(([key, value]) => `${key}=${value}`).join(" ")
    : "";
  return [
    diag.tag ? `etiket=${diag.tag}` : "",
    `href=${diag.href || "(yok)"}`,
    `onclick=${diag.onclick || "(yok)"}`,
    attrs ? `attr=${attrs}` : "",
    diag.elementHtml ? `eleman=${diag.elementHtml}` : "",
    diag.rowHtml ? `satır=${diag.rowHtml}` : "",
    diag.oauth ? `oauth=${diag.oauth}` : "",
    Array.isArray(diag.agreement) && diag.agreement.length ? `sozlesme=${diag.agreement.join(",")}` : "",
    diag.strategies ? `denenen=${diag.strategies}` : "",
  ].filter(Boolean).join(" | ");
}

function armSurfaceWatch(session) {
  const page = session.page;
  const startUrl = page.url();
  const popups = [];
  const retryJobs = new WeakMap();
  const track = (popup) => {
    if (!popup || popups.includes(popup)) return;
    popups.push(popup);
    const onReq = (req) => notePopupRequest(session, popup, req);
    popup.on("request", onReq);
    popup.on("requestfailed", onReq);
  };
  const onPage = (popup) => { track(popup); };
  const onContextRequest = (req) => {
    let popup = null;
    try { popup = req.frame()?.page(); } catch { return; }
    if (!popup || popup === page) return;
    track(popup);
    notePopupRequest(session, popup, req);
  };
  session.context.on("page", onPage);
  session.context.on("request", onContextRequest);
  session.context.on("requestfailed", onContextRequest);
  const retryChromeError = (popup) => {
    const existing = retryJobs.get(popup);
    if (existing) return existing;
    const job = (async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (!pageOpen(popup)) return;
        const current = currentUrl(popup) || "";
        if (current && current !== "about:blank" && !isChromeError(current)) return;
        const target = intentOf(popup) || session.popupIntent || "";
        log({
          level: "info",
          step: STEPS.popup.id,
          stepNo: STEPS.popup.n,
          stepName: STEPS.popup.name,
          event: "popup-retry",
          email: session.email,
          sessionId: session.id,
          url: target || current,
          message: `CJ popup yeniden deneniyor ${attempt}/3${target ? `: ${target}` : ""}`,
        });
        try {
          if (target) await popup.goto(target, { waitUntil: "domcontentloaded", timeout: cjNavTimeout() });
          else await popup.reload({ waitUntil: "domcontentloaded", timeout: cjNavTimeout() });
        } catch {
          // Zaman aşımı ve net::ERR_ yeniden denemeyi kesmez.
        }
        const after = currentUrl(popup) || "";
        if (after && after !== "about:blank" && !isChromeError(after)) return;
      }
    })();
    retryJobs.set(popup, job);
    return job;
  };
  const look = async () => {
    const candidates = [...popups];
    for (const candidate of session.context.pages()) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    for (const candidate of candidates) {
      if (!pageOpen(candidate)) continue;
      if (candidate !== page) {
        const candidateUrl = currentUrl(candidate) || "";
        if (isChromeError(candidateUrl)) {
          void retryChromeError(candidate);
          continue;
        }
        if (candidateUrl && candidateUrl !== "about:blank") return { kind: "popup", page: candidate, intent: intentOf(candidate) || session.popupIntent || "" };
      }
      for (const frame of safeFrames(candidate)) {
        if (frame === candidate.mainFrame()) continue;
        let frameUrl = "";
        try { frameUrl = frame.url(); } catch { continue; }
        if (!frameUrl || frameUrl === "about:blank" || isChromeError(frameUrl)) continue;
        if (isCjUrl(frameUrl)) return { kind: "frame", frame, page: candidate };
        const emailVisible = await frame.locator(SEL.cjEmail).first().isVisible().catch(() => false);
        if (emailVisible) return { kind: "frame", frame, page: candidate };
      }
    }
    const mainUrl = currentUrl(page) || "";
    if (mainUrl && !isChromeError(mainUrl) && (isCjUrl(mainUrl) || (pathOf(mainUrl) && pathOf(mainUrl) !== pathOf(startUrl)))) {
      return { kind: "redirect", page };
    }
    return null;
  };
  return {
    async poll(timeout) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const target = await look().catch((err) => {
          if (isContextDestroyed(err)) return null;
          throw err;
        });
        if (target) return target;
        await delay(200);
      }
      return look().catch(() => null);
    },
    async once() {
      return look().catch(() => null);
    },
    async finishRetries() {
      const jobs = [];
      for (const candidate of session.context.pages()) {
        if (candidate === page || !pageOpen(candidate)) continue;
        const url = currentUrl(candidate) || "";
        if (!isChromeError(url) && !retryJobs.has(candidate)) continue;
        jobs.push(retryChromeError(candidate));
      }
      await Promise.all(jobs.map((job) => Promise.resolve(job).catch(() => {})));
    },
    stop() {
      session.context?.off("page", onPage);
      session.context?.off("request", onContextRequest);
      session.context?.off("requestfailed", onContextRequest);
    },
  };
}

function attachClickTrace(session) {
  const lines = [];
  session.clickTrace = lines;
  const push = (line) => {
    if (lines.length >= 12) return;
    lines.push(redact(line, 180));
  };
  const onConsole = (msg) => {
    const type = msg.type();
    if (type === "debug" || type === "verbose") return;
    push(`konsol ${type}: ${msg.text()}`);
  };
  const onFailed = (req) => {
    const url = req.url();
    if (/favicon\.ico/i.test(url)) return;
    const reason = req.failure()?.errorText || "";
    if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(reason)) return;
    push(`istek fail ${reason || "fail"} ${req.method()} ${url}`);
  };
  const onResponse = (res) => {
    if (res.status() < 400) return;
    const url = res.url();
    if (/favicon\.ico/i.test(url)) return;
    push(`istek ${res.status()} ${res.request().method()} ${url}`);
  };
  const pages = new Set();
  const bindPage = (p) => {
    if (!p || pages.has(p)) return;
    pages.add(p);
    p.on("console", onConsole);
  };
  bindPage(session.page);
  const onPopup = (p) => bindPage(p);
  session.context.on("page", onPopup);
  session.context.on("requestfailed", onFailed);
  session.context.on("response", onResponse);
  return () => {
    for (const p of pages) p.off("console", onConsole);
    session.context?.off("page", onPopup);
    session.context?.off("requestfailed", onFailed);
    session.context?.off("response", onResponse);
  };
}

async function readCjMarkup(el) {
  return el.evaluate((node) => {
    const clip = (value, n) => String(value || "").replace(/\s+/g, " ").trim().slice(0, n);
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
    let row = node;
    for (let i = 0; i < 8 && row?.parentElement; i += 1) {
      const icons = [...row.querySelectorAll("img, svg, a, button")].filter(visible);
      const hasWa = !!(wa && row.contains(wa));
      if (hasWa && icons.length >= 3) break;
      row = row.parentElement;
    }
    const link = node.closest?.("a, button, [role='button']") || node;
    const attrs = {};
    const keep = new Set(["id", "class", "src", "alt", "role", "type", "href", "title", "aria-label"]);
    for (const source of [node, link !== node ? link : null]) {
      if (!source?.attributes) continue;
      for (const attr of source.attributes) {
        if (attrs[attr.name]) continue;
        if (attr.name === "onclick" || attr.name.startsWith("data-") || keep.has(attr.name)) attrs[attr.name] = clip(attr.value, 300);
      }
    }
    const href = link?.getAttribute?.("href") || node.getAttribute?.("href") || "";
    const onclick = node.getAttribute?.("onclick") || link?.getAttribute?.("onclick") || "";
    return {
      tag: node.tagName || "",
      href: clip(href, 500),
      onclick: clip(onclick, 500),
      attrs,
      elementHtml: clip(node.outerHTML, 1500),
      rowHtml: clip((row || node).outerHTML, 3500),
    };
  });
}

async function findOauthUrl(page) {
  for (const frame of safeFrames(page)) {
    const found = await frame.evaluate(() => {
      const interesting = /cjdropshipping|oauth|authorize/i;
      const asset = /\.(?:png|jpe?g|gif|svg|css|woff2?|js|map)(?:$|\?)/i;
      const chunks = [];
      for (const script of document.scripts) {
        if (script.src) chunks.push(script.src);
        if (script.textContent) chunks.push(script.textContent.slice(0, 100000));
      }
      for (const el of document.querySelectorAll("[onclick]")) chunks.push(el.getAttribute("onclick") || "");
      if (document.documentElement) chunks.push(document.documentElement.innerHTML.slice(0, 200000));
      const blob = chunks.join("\n");
      const candidates = [];
      const push = (value) => {
        const raw = String(value || "").trim().replace(/[),.;]+$/, "");
        if (!raw || !interesting.test(raw) || asset.test(raw) || /^(javascript|data):/i.test(raw)) return;
        if (!/^https?:\/\//i.test(raw) && !raw.startsWith("/") && !raw.startsWith("./") && !raw.startsWith("../")) return;
        if (!candidates.includes(raw)) candidates.push(raw);
      };
      for (const match of blob.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)) push(match[0]);
      for (const match of blob.matchAll(/['"`]([^'"`]{1,500})['"`]/g)) push(match[1]);
      for (const match of blob.matchAll(/['"](https?:\/\/[^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/g)) push(match[1] + match[2]);
      return candidates.find((item) => /cjdropshipping/i.test(item) && /oauth|authorize/i.test(item))
        || candidates.find((item) => /cjdropshipping/i.test(item))
        || candidates[0]
        || null;
    }).catch((err) => {
      if (isContextDestroyed(err)) return null;
      return null;
    });
    if (found) return found;
  }
  return null;
}

async function checkAgreement(page) {
  const names = [];
  for (const frame of safeFrames(page)) {
    const found = await frame.evaluate(() => {
      const re = /agree|terms|privacy|policy|user agreement|sözleş|gizlilik|onay|协议|隐私/i;
      const shown = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const hits = [];
      for (const box of document.querySelectorAll("input[type='checkbox'], [role='checkbox']")) {
        let labelEl = box.labels && box.labels.length ? box.labels[0] : box.closest("label");
        if (!labelEl && box.id) {
          try { labelEl = document.querySelector(`label[for="${CSS.escape(box.id)}"]`); } catch { labelEl = null; }
        }
        if (!shown(box) && !shown(labelEl)) continue;
        const blob = [box.getAttribute("name"), box.getAttribute("id"), box.getAttribute("aria-label"), box.getAttribute("class"), labelEl ? labelEl.innerText : ""].filter(Boolean).join(" ");
        if (!re.test(blob)) continue;
        const role = box.getAttribute("role");
        const checked = role === "checkbox" ? box.getAttribute("aria-checked") === "true" : !!box.checked;
        if (checked) continue;
        box.click();
        if (role !== "checkbox" && !box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
        }
        hits.push(String(labelEl?.innerText || box.getAttribute("name") || box.id || "checkbox").replace(/\s+/g, " ").trim().slice(0, 80));
      }
      return hits;
    }).catch((err) => {
      if (isContextDestroyed(err)) return [];
      throw err;
    });
    names.push(...(found || []));
  }
  return names;
}

async function cjTargetsCaptcha(el) {
  if (!el) return false;
  return el.evaluate((node) => {
    const title = document.title || "";
    if (document.querySelector("meta[name='validation']") || /human verification/i.test(title) || document.querySelector("#verifyCode")) return true;
    if (node.id === "verifyCode" || node.closest?.("#verifyCode")) return true;
    if (node.closest?.("#validation, .validation-page, [data-page='validation']")) return true;
    return false;
  }).catch(() => false);
}

async function acquireCj(session) {
  const page = session.page;
  if (!pageOpen(page)) return null;
  const el = CJ_BUTTON_OVERRIDE
    ? await page.locator(CJ_BUTTON_OVERRIDE).first().elementHandle({ timeout: 3000 }).catch(() => null)
    : await findCj(page);
  if (el && await cjTargetsCaptcha(el)) {
    await el.dispose().catch(() => {});
    return null;
  }
  return el;
}

async function rememberCj(session, el) {
  const markup = await readCjMarkup(el).catch(() => null);
  const oauth = await findOauthUrl(session.page).catch(() => null);
  session.cjDiag = { ...(markup || {}), oauth: oauth || "" };
  log({
    level: "info",
    step: STEPS.cjButton.id,
    stepNo: STEPS.cjButton.n,
    stepName: STEPS.cjButton.name,
    event: "markup",
    email: session.email,
    sessionId: session.id,
    url: currentUrl(session.page),
    message: `CJ öğesi ${session.cjDiag.tag || "?"} href=${session.cjDiag.href || "(yok)"}`,
    detail: formatCjDiag(session.cjDiag),
  });
}

async function parentControl(el) {
  const parent = await el.evaluateHandle((node) => {
    const own = node.closest?.("a, button, [role='button']");
    const start = own && own !== node ? own : node.parentElement;
    const host = start?.closest?.("a, button, [role='button']") || null;
    return host && host !== node ? host : null;
  });
  const parentEl = parent.asElement();
  if (!parentEl) await parent.dispose().catch(() => {});
  return parentEl;
}

async function strategyApplies(session, name) {
  if (name === "href" || name === "oauth") {
    const raw = name === "href" ? session.cjDiag?.href : session.cjDiag?.oauth;
    return !!usableHref(raw, currentUrl(session.page) || "");
  }
  if (name !== "üst") return true;
  const el = await acquireCj(session);
  if (!el) return false;
  try {
    const parentEl = await parentControl(el);
    const ok = !!parentEl;
    if (parentEl) await parentEl.dispose().catch(() => {});
    return ok;
  } finally {
    await el.dispose().catch(() => {});
  }
}

async function performStrategy(session, name) {
  if (name === "href" || name === "oauth") {
    const raw = name === "href" ? session.cjDiag?.href : session.cjDiag?.oauth;
    const url = usableHref(raw, currentUrl(session.page) || session.page.url());
    if (!url) return "skip";
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: cjStrategyWait() });
    return "run";
  }
  const el = await acquireCj(session);
  if (!el) throw new Error("CJ öğesi yeniden bulunamadı");
  try {
    if (name === "tık") {
      await el.click({ timeout: 5000, noWaitAfter: true });
      return "run";
    }
    if (name === "js") {
      await el.evaluate((node) => node.click());
      return "run";
    }
    const parentEl = await parentControl(el);
    if (!parentEl) return "skip";
    try {
      await parentEl.evaluate((node) => node.click());
    } finally {
      await parentEl.dispose().catch(() => {});
    }
    return "run";
  } finally {
    await el.dispose().catch(() => {});
  }
}

function logCjStrategy(session, message) {
  log({
    level: "info",
    step: STEPS.popup.id,
    stepNo: STEPS.popup.n,
    stepName: STEPS.popup.name,
    event: "strategy",
    email: session.email,
    sessionId: session.id,
    url: currentUrl(session.page),
    message,
  });
}

async function runCjStrategies(session, watch) {
  const waitMs = cjStrategyWait();
  const tried = [];
  let target = null;
  let winner = "";
  for (const name of ["tık", "üst", "js", "href", "oauth"]) {
    if (target) break;
    const applies = await strategyApplies(session, name).catch(() => false);
    if (!applies) {
      tried.push(`${name}:atlandı`);
      logCjStrategy(session, `CJ denemesi atlandı: ${name}`);
      continue;
    }
    logCjStrategy(session, `CJ denemesi: ${name}`);
    const pending = watch.poll(waitMs);
    let failure = null;
    const acted = performStrategy(session, name).catch((err) => {
      failure = err;
    });
    const found = await pending;
    await acted;
    tried.push(name);
    if (failure && !isContextDestroyed(failure) && session.clickTrace && session.clickTrace.length < 12) {
      session.clickTrace.push(redact(`strateji ${name}: ${failure.message || failure}`, 180));
    }
    if (found) {
      target = found;
      winner = name;
    }
  }
  if (session.cjDiag) session.cjDiag.strategies = tried.join(",");
  else session.cjDiag = { strategies: tried.join(",") };
  return { target, winner, tried };
}

async function loginRoots(session) {
  const roots = [];
  const pushPage = (p) => {
    if (!pageOpen(p)) return;
    for (const frame of safeFrames(p)) roots.push(frame);
  };
  if (session.loginFrame) roots.push(session.loginFrame);
  if (session.cjKind === "popup") pushPage(session.popup || session.active);
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
    const diagText = formatCjDiag(ctx.cjDiag);
    const trace = Array.isArray(ctx.clickTrace) ? ctx.clickTrace.join(" | ") : "";
    const intentLine = ctx.popupIntent && !String(surfaces || "").includes("popup hedef:") ? `popup hedef: ${ctx.popupIntent}` : "";
    const detailText = [publicDetail(err), surfaces, intentLine, diagText, trace].filter(Boolean).join(" | ");
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
    const pauseCaptcha = () => {
      const pause = new Error("captcha");
      pause.captchaPause = true;
      throw pause;
    };
    let el = null;
    if (await anyFrame(page, validationMarkersInDocument)) pauseCaptcha();
    if (CJ_BUTTON_OVERRIDE) {
      const btn = page.locator(CJ_BUTTON_OVERRIDE).first();
      try {
        await btn.waitFor({ state: "visible", timeout: TIMEOUTS.cjButton });
        el = await btn.elementHandle();
      } catch (err) {
        if (isTimeout(err) || isMissing(err)) err.code = "missing-button";
        throw err;
      }
    } else {
      const deadline = Date.now() + TIMEOUTS.cjButton;
      while (Date.now() < deadline) {
        if (await anyFrame(page, validationMarkersInDocument)) pauseCaptcha();
        el = await findCj(page);
        if (el) break;
        await delay(200);
      }
      if (!el) {
        if (await anyFrame(page, validationMarkersInDocument)) pauseCaptcha();
        throw Object.assign(new Error("missing-button"), { code: "missing-button" });
      }
      const position = await positionAgainstWhatsapp(el).catch(() => ({ ok: true, reason: "whatsapp-yok" }));
      if (position && position.ok === false) {
        await el.dispose().catch(() => {});
        if (position.reason === "verifyCode" || await anyFrame(page, validationMarkersInDocument)) pauseCaptcha();
        throw Object.assign(new Error("not-left"), { code: "not-left", position: `ikon x=${position.left}, WhatsApp x=${position.wa}` });
      }
    }
    if (el && await cjTargetsCaptcha(el)) {
      await el.dispose().catch(() => {});
      pauseCaptcha();
    }
    try {
      await rememberCj(session, el);
    } finally {
      await el.dispose().catch(() => {});
    }
  },
  async popup(session) {
    const stopTrace = attachClickTrace(session);
    const watch = armSurfaceWatch(session);
    let opened = null;
    try {
      const agreed = await checkAgreement(session.page).catch((err) => {
        if (isContextDestroyed(err)) return [];
        if (session.clickTrace && session.clickTrace.length < 12) session.clickTrace.push(redact(`sozlesme: ${err.message || err}`, 180));
        return [];
      });
      if (agreed.length) {
        session.cjDiag = { ...(session.cjDiag || {}), agreement: agreed };
        log({
          level: "info",
          step: STEPS.popup.id,
          stepNo: STEPS.popup.n,
          stepName: STEPS.popup.name,
          event: "agreement",
          email: session.email,
          sessionId: session.id,
          url: currentUrl(session.page),
          message: `Sözleşme kutusu işaretlendi: ${agreed.join(", ")}`,
        });
      }
      opened = await runCjStrategies(session, watch);
      if (!opened?.target) {
        await watch.finishRetries();
        const late = await watch.once();
        if (late) opened = { target: late, winner: "yeniden" };
      }
    } finally {
      watch.stop();
      stopTrace();
    }
    const target = opened?.target;
    if (!target) {
      throw Object.assign(new Error("no-redirect"), {
        code: "no-redirect",
        surfaces: await describeSurfaces(session),
        popupIntent: session.popupIntent || "",
        diag: session.cjDiag,
        trace: (session.clickTrace || []).join(" | "),
      });
    }
    session.cjKind = target.kind;
    if (target.kind === "popup") {
      session.popup = target.page;
      session.active = target.page;
      await target.page.waitForLoadState("domcontentloaded", { timeout: cjNavTimeout() }).catch((err) => {
        if (!isContextDestroyed(err) && !isTimeout(err)) throw err;
      });
    } else if (target.kind === "frame") {
      session.loginFrame = target.frame;
      session.active = target.page;
    } else {
      session.active = target.page;
      await target.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch(() => {});
    }
    const how = opened.winner ? ` (${opened.winner})` : "";
    log({
      level: "info",
      step: STEPS.popup.id,
      stepNo: STEPS.popup.n,
      stepName: STEPS.popup.name,
      event: target.kind,
      email: session.email,
      sessionId: session.id,
      url: target.kind === "frame" ? target.frame.url() : currentUrl(target.page),
      message: target.kind === "popup" ? `CJ penceresi açıldı${how}` : target.kind === "frame" ? `CJ çerçevesi bulundu${how}` : `CJ sayfasına geçildi${how}`,
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
  if (await anyFrame(page, validationMarkersInDocument)) return false;
  if (await anyFrame(page, registerFormInDocument)) return true;
  if (!url || pathOf(url) === pathOf(startUrl) || isValidationPath(url)) return false;
  return !(await isCaptchaPage(page).catch(() => true));
}

async function settleAfterCaptchaSubmit(page, beforeSrc, startUrl, hadError, turnstileDeadline) {
  await waitForTurnstile(page, turnstileDeadline).catch(() => {});
  const timeout = TIMEOUTS.captcha;
  let stop = false;
  let sawReload = false;
  const changeWait = async () => {
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
  };
  let winner;
  try {
    winner = await changeWait();
  } finally {
    stop = true;
  }
  if (winner === "register") {
    await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch((err) => {
      if (!isContextDestroyed(err) && !isTimeout(err)) throw err;
    });
    const url = currentUrl(page) || "";
    if (await anyFrame(page, validationMarkersInDocument)) return "captcha";
    if (await leftCaptcha(page, url, startUrl)) return "register";
    return "captcha";
  }
  if (winner === "captcha") return "captcha";
  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(TIMEOUTS.navigation, 15000) }).catch(() => {});
  const url = currentUrl(page) || "";
  if (await leftCaptcha(page, url, startUrl)) return "register";
  if (await anyFrame(page, validationMarkersInDocument).catch(() => false)) return "captcha";
  if (isValidationPath(url) || pathOf(url) === pathOf(startUrl) || await isCaptchaPage(page).catch(() => false)) return "captcha";
  throw Object.assign(new Error(`Timeout exceeded while waiting after captcha submit (${url || "url yok"})`), { name: "TimeoutError" });
}

async function submitCaptchaCode(session, code) {
  const page = pageOpen(session.active) ? session.active : session.page;
  session.active = page;
  session.currentStep = STEPS.captcha;
  if (!(await isCaptchaPage(page).catch(() => false))) return drive(session);
  let outcome = "register";
  const turnstileDeadline = Date.now() + turnstileTimeout();
  await runStep(session, STEPS.captcha, async () => {
    const before = await queryCaptchaState(page).catch(() => ({ src: "" }));
    const hadError = await captchaErrorVisible(page).catch(() => false);
    const startUrl = currentUrl(page) || page.url();
    const input = page.locator(CAPTCHA_INPUT).first();
    await input.waitFor({ state: "visible", timeout: TIMEOUTS.captcha });
    await input.fill(String(code), { timeout: TIMEOUTS.captcha });
    await waitForTurnstile(page, turnstileDeadline);
    try {
      await page.locator(CAPTCHA_SUBMIT).first().click({ timeout: TIMEOUTS.captcha, noWaitAfter: true });
    } catch (err) {
      if (!isContextDestroyed(err)) throw err;
    }
    outcome = await settleAfterCaptchaSubmit(page, before?.src || "", startUrl, hadError, turnstileDeadline);
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
      error: redact(err.message, 9000),
      step: err.stepId,
      url: safeUrl,
      screenshot: screenshots[0]?.image || shot,
      screenshots,
      blocker: err.blocker ?? null,
      detail: err.detail ? redact(err.detail, 9000) : null,
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

const configured = ["QK_LOGIN_URL", "SEL_LOGIN_URL", "SEL_CJ_BUTTON", "SEL_CJ_EMAIL", "SEL_CJ_PASSWORD", "SEL_CJ_SUBMIT", "SEL_CJ_AUTHORIZE", "SEL_SUCCESS", "SEL_ERROR_TEXT", "SEL_CAPTCHA", "SEL_CAPTCHA_INPUT", "SEL_CAPTCHA_SUBMIT", "SEL_CAPTCHA_IMAGE", "BROWSER_LOCALE", "BROWSER_TZ", "BROWSER_UA", "PROXY_URL", "TIMEOUT_OPEN_LOGIN", "TIMEOUT_CAPTCHA", "TIMEOUT_CJ_BUTTON", "TIMEOUT_CJ_CLICK", "TIMEOUT_CJ_NAVIGATION", "TIMEOUT_TURNSTILE", "TIMEOUT_POPUP", "TIMEOUT_NAVIGATION", "TIMEOUT_EMAIL", "TIMEOUT_PASSWORD", "TIMEOUT_SUBMIT", "TIMEOUT_AUTHORIZE", "TIMEOUT_SUCCESS", "SESSION_TTL_MS"]
  .filter((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");
log({ level: "info", step: "config", event: "env", message: configured.length ? `Ayarlı ortam değişkenleri: ${configured.join(", ")}` : "Seçici ve zaman aşımı varsayılanları kullanılıyor" });
log({ level: "info", step: "config", event: "timeouts", message: `Zaman aşımları ms: açık=${TIMEOUTS.openLogin}, captcha=${TIMEOUTS.captcha}, cj=${TIMEOUTS.cjButton}, cjTik=${envMs("TIMEOUT_CJ_CLICK", 20000)}, cjNav=${cjNavTimeout()}, turnstile=${turnstileTimeout()}, proxy=${PROXY_URL ? "var" : "yok"}` });

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
