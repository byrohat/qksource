import express from "express";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

// CJ şifresi ve doğrulama kodu yalnızca işlem sırasında burada durur; loglara yazılmaz.
let activeSecrets = [];

const warned = new Set();
const sessions = new Map();
let activeSessionId = null;

function redact(text, limit = 0) {
  let s = String(text ?? "");
  for (const secret of activeSecrets) {
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
  cjEmail: envStr("SEL_CJ_EMAIL", 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="mail" i]'),
  cjPassword: envStr("SEL_CJ_PASSWORD", 'input[type="password"]'),
  cjSubmit: envStr("SEL_CJ_SUBMIT", 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")'),
  cjAuthorize: envStr("SEL_CJ_AUTHORIZE", "button:has-text('Authorize'), button:has-text('Allow'), button:has-text('Agree'), button:has-text('Confirm'), button:has-text('Yetki')"),
  successCheck: envStr("SEL_SUCCESS", "text=/Dashboard|My Store|Logout|Sign out|Log out|Hesabım/i"),
  errorText: envStr("SEL_ERROR_TEXT", "text=/incorrect password|wrong password|invalid password|invalid credentials|login failed|account or password|username or password|şifre hatalı|şifre yanlış|hatalı şifre|密码错误|账号或密码|用户名或密码/i"),
};

const TIMEOUTS = {
  openLogin: envMs("TIMEOUT_OPEN_LOGIN", 45000),
  captcha: envMs("TIMEOUT_CAPTCHA", 20000),
  cjButton: envMs("TIMEOUT_CJ_BUTTON", 20000),
  popup: envMs("TIMEOUT_POPUP", 8000),
  navigation: envMs("TIMEOUT_NAVIGATION", 30000),
  email: envMs("TIMEOUT_EMAIL", 30000),
  password: envMs("TIMEOUT_PASSWORD", 30000),
  submit: envMs("TIMEOUT_SUBMIT", 30000),
  authorize: envMs("TIMEOUT_AUTHORIZE", 10000),
  success: envMs("TIMEOUT_SUCCESS", 45000),
};

const SESSION_TTL = envMs("SESSION_TTL_MS", 5 * 60 * 1000);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!err || err.blockerKind || err.handled || err.captchaPause || err.code === "bad-url" || isBadSelector(err)) return false;
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
  if (err?.blockerKind === "credentials") return `Adım ${n}: CJ kimlik bilgileri reddedildi`;
  if (err?.code === "bad-url") return `Adım ${n}: Kayıt adresi geçersiz (QK_LOGIN_URL)`;
  if (err?.code === "no-redirect") return `Adım ${n}: CJ penceresi veya yönlendirme algılanamadı`;
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

async function isCaptchaPage(page) {
  if (!pageOpen(page)) return false;
  for (const frame of page.frames()) {
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
    const buffer = await page.screenshot({ fullPage: false, timeout: 5000 });
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

// Kod çözülmez. Operatörün göreceği resim, doğrulama alanının üstündeki görseldir.
async function captureCaptchaImage(page) {
  if (!pageOpen(page)) return null;
  if (CAPTCHA_IMAGE) {
    try {
      const loc = page.locator(CAPTCHA_IMAGE).first();
      if (await loc.isVisible().catch(() => false)) {
        return (await loc.screenshot({ timeout: 5000 })).toString("base64");
      }
    } catch {
      // Aşağıdaki yerleşim yedeğine düş.
    }
  }
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(() => {
        const visible = (el) => {
          if (!el?.getClientRects?.().length) return false;
          const s = getComputedStyle(el);
          return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
        };
        const input = [...document.querySelectorAll("input")].find((el) => visible(el) && /verification code|doğrulama kodu|captcha|verify/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`));
        const media = [...document.querySelectorAll("img, canvas")].filter(visible);
        if (input && media.length) {
          const ir = input.getBoundingClientRect();
          const above = media
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 16 && r.height > 10 && r.bottom <= ir.top + 12)
            .sort((a, b) => (ir.top - a.r.bottom) - (ir.top - b.r.bottom));
          if (above[0]) return above[0].el;
        }
        return media.find((el) => /captcha|verify|code/i.test(`${el.getAttribute("src") || ""} ${el.getAttribute("alt") || ""} ${el.id || ""}`)) || null;
      });
    } catch {
      continue;
    }
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => {});
      continue;
    }
    try {
      return (await el.screenshot({ timeout: 5000 })).toString("base64");
    } catch {
      await el.dispose().catch(() => {});
    }
  }
  return takeScreenshot(page);
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
    if (recover) await withDeadline(recover, 3000).catch(() => {});
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
  const nodes = [...document.querySelectorAll("img, a, button, [role='button'], svg, i, span")];
  const cj = nodes.find((el) => visible(el) && /cj/i.test(textOf(el)));
  if (cj) return cj.closest("a, button, [role='button']") || cj;
  const wa = nodes.find((el) => visible(el) && /whatsapp/i.test(textOf(el)));
  if (!wa) return null;
  let row = wa.parentElement;
  for (let i = 0; i < 5 && row; i += 1) {
    if (row.children.length >= 4) break;
    row = row.parentElement;
  }
  const first = row?.children?.[0];
  if (!first || first === wa || first.contains(wa)) return null;
  return first.querySelector("img, a, button") || first;
}

async function findCj(page) {
  for (const frame of page.frames()) {
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

async function runStep(ctx, step, fn) {
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
      sessionId: ctx.id,
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
    if (await isCaptchaPage(page)) {
      return captchaResult(session, await captureCaptchaImage(page));
    }
    const key = PHASES[session.phaseIndex];
    try {
      await runStep(session, STEPS[key], () => STEP_FNS[key](session));
    } catch (err) {
      if (err?.captchaPause) return captchaResult(session, err.image || null);
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
      session.pendingPopup = session.context.waitForEvent("page", { timeout: TIMEOUTS.popup }).catch(() => null);
      await btn.click({ timeout: TIMEOUTS.cjButton });
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
    session.pendingPopup = session.context.waitForEvent("page", { timeout: TIMEOUTS.popup }).catch(() => null);
    try {
      await el.click({ timeout: TIMEOUTS.cjButton });
    } finally {
      await el.dispose().catch(() => {});
    }
  },
  async popup(session) {
    const popup = await session.pendingPopup;
    session.pendingPopup = null;
    session.popup = popup || null;
    if (popup) {
      session.active = popup;
      await withNavRetry(session, STEPS.popup, () => popup.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }), {
        timeoutMs: TIMEOUTS.navigation,
      });
      log({
        level: "info",
        step: STEPS.popup.id,
        stepNo: STEPS.popup.n,
        stepName: STEPS.popup.name,
        event: "popup",
        email: session.email,
        sessionId: session.id,
        url: currentUrl(popup),
        message: "CJ penceresi açıldı",
      });
      return;
    }
    session.active = session.page;
    await session.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.navigation }).catch(() => {});
    const stillRegister = await session.page.locator("text=/Create a Qksource account|Confirm Password/i").first().isVisible().catch(() => false);
    const url = currentUrl(session.page) || "";
    if (stillRegister && !/cjdropshipping|cj\.com/i.test(url)) {
      throw Object.assign(new Error("no-redirect"), { code: "no-redirect" });
    }
    log({
      level: "info",
      step: STEPS.popup.id,
      stepNo: STEPS.popup.n,
      stepName: STEPS.popup.name,
      event: "same-tab",
      email: session.email,
      sessionId: session.id,
      url,
      message: "Aynı sekmede devam ediliyor",
    });
  },
  async email(session) {
    const page = session.active;
    await page.locator(SEL.cjEmail).first().fill(session.email, { timeout: TIMEOUTS.email });
  },
  async password(session) {
    const page = session.active;
    await page.locator(SEL.cjPassword).first().fill(session.password, { timeout: TIMEOUTS.password });
  },
  async submit(session) {
    const page = session.active;
    try {
      await page.locator(SEL.cjSubmit).first().click({ timeout: TIMEOUTS.submit });
    } catch (err) {
      if (!pageOpen(page)) return;
      throw err;
    }
    if (pageOpen(page)) {
      await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.submit }).catch(() => {});
      await delay(300);
    }
    if (await detectCredentials(page)) throw blockerError("credentials");
  },
  async authorize(session) {
    if (!pageOpen(session.active)) session.active = session.page;
    if (pageOpen(session.active)) {
      const auth = session.active.locator(SEL.cjAuthorize).first();
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
    session.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    session.context = await session.browser.newContext({ viewport: { width: 1280, height: 900 } });
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

async function submitCaptchaCode(session, code) {
  const page = pageOpen(session.active) ? session.active : session.page;
  session.active = page;
  if (!(await isCaptchaPage(page))) return drive(session);
  await runStep(session, STEPS.captcha, async () => {
    const input = page.locator(CAPTCHA_INPUT).first();
    await input.waitFor({ state: "visible", timeout: TIMEOUTS.captcha });
    await input.fill(String(code), { timeout: TIMEOUTS.captcha });
    try {
      await page.locator(CAPTCHA_SUBMIT).first().click({ timeout: TIMEOUTS.captcha });
    } catch (err) {
      if (!pageOpen(page)) return;
      throw err;
    }
    if (pageOpen(page)) {
      await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.captcha }).catch(() => {});
      await delay(700);
    }
  });
  return drive(session);
}

function failureBody(err, session) {
  if (err?.code === "expired" || session?.closing) {
    return { ok: false, status: "error", error: "Oturum bulunamadı veya süresi doldu", step: "session", url: null, screenshot: null, blocker: null };
  }
  if (err?.handled) {
    return {
      ok: false,
      status: "error",
      error: redact(err.message, 500),
      step: err.stepId,
      url: err.url ?? null,
      screenshot: err.screenshot ?? null,
      blocker: err.blocker ?? null,
    };
  }
  return {
    ok: false,
    status: "error",
    error: "Beklenmeyen otomasyon hatası",
    step: "onboard",
    url: currentUrl(session?.active) || currentUrl(session?.page),
    screenshot: null,
    blocker: null,
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

const configured = ["QK_LOGIN_URL", "SEL_LOGIN_URL", "SEL_CJ_BUTTON", "SEL_CJ_EMAIL", "SEL_CJ_PASSWORD", "SEL_CJ_SUBMIT", "SEL_CJ_AUTHORIZE", "SEL_SUCCESS", "SEL_ERROR_TEXT", "SEL_CAPTCHA", "SEL_CAPTCHA_INPUT", "SEL_CAPTCHA_SUBMIT", "SEL_CAPTCHA_IMAGE", "TIMEOUT_OPEN_LOGIN", "TIMEOUT_CAPTCHA", "TIMEOUT_CJ_BUTTON", "TIMEOUT_POPUP", "TIMEOUT_NAVIGATION", "TIMEOUT_EMAIL", "TIMEOUT_PASSWORD", "TIMEOUT_SUBMIT", "TIMEOUT_AUTHORIZE", "TIMEOUT_SUCCESS", "SESSION_TTL_MS"]
  .filter((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");
log({ level: "info", step: "config", event: "env", message: configured.length ? `Ayarlı ortam değişkenleri: ${configured.join(", ")}` : "Seçici ve zaman aşımı varsayılanları kullanılıyor" });

const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain; charset=utf-8").send("ok");
});

app.post("/onboard", async (req, res) => {
  const { cjEmail, cjPassword } = req.body || {};
  if (typeof cjEmail !== "string" || typeof cjPassword !== "string" || cjEmail.length === 0 || cjPassword.length === 0) {
    return res.status(400).json({ ok: false, status: "error", error: "CJ e-posta ve şifre gerekli" });
  }
  if (sessions.size > 0) {
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
    log({
      level: "error",
      step: "onboard",
      event: "fail",
      email: session.email,
      sessionId: session.id,
      message: err?.handled ? err.message : "Beklenmeyen otomasyon hatası",
      detail: err?.handled ? null : err?.message,
    });
    const body = failureBody(err, session);
    await closeSession(session.id);
    res.status(err?.handled ? 200 : 500).json(body);
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
    log({
      level: "error",
      step: "captcha",
      event: "fail",
      email: session.email,
      sessionId: session.id,
      message: err?.handled ? err.message : "Beklenmeyen otomasyon hatası",
      detail: err?.handled ? null : err?.message,
    });
    const body = failureBody(err, session);
    await closeSession(session.id);
    res.status(err?.handled ? 200 : 500).json(body);
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
  else{r.innerHTML='<p class="err">❌ Hata: '+esc((j&&j.error)||'yanıt yok')+'</p>'+(j&&j.url?'<p>URL: '+esc(j.url)+'</p>':'')+(j&&j.screenshot?'<img alt="Hata ekran görüntüsü" src="data:image/png;base64,'+String(j.screenshot).replace(/[^A-Za-z0-9+/=]/g,'')+'">':'');}
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
