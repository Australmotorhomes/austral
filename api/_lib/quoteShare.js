// Shared helpers for the quote-sharing API routes.
// Plain CommonJS + global fetch (Node 18+), so there are no new npm dependencies.

const crypto = require("crypto");

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.REACT_APP_SUPABASE_URL ||
  "https://dpapwmittcowsrwwsajo.supabase.co"
).replace(/\/$/, "");

// Publishable (anon) key — public by design; same value the browser app already uses.
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.REACT_APP_SUPABASE_ANON_KEY ||
  "sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn";

const LINK_LIFETIME_DAYS = 14;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

// The exact wording shown next to the tick box. It is stored with the acceptance
// as evidence of what the customer agreed to. Deliberately does not restate the
// percentages, so it can never disagree with the quote's own payment-terms text.
const ACCEPT_TERMS_TEXT =
  "I have read and agree to the Terms of Trade linked in this quote, including the cancellation and refund terms, and I accept the payment instalments set out in this quote.";

function serviceKey() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return k;
}

// Server-side Supabase REST call using the secret key (bypasses RLS).
async function sb(path, { method = "GET", body, prefer } = {}) {
  const key = serviceKey();
  const headers = { apikey: key, "Content-Type": "application/json" };
  // Legacy service_role keys are JWTs and are also sent as a Bearer token.
  // New-style "sb_secret_..." keys are NOT JWTs and go in `apikey` only.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Supabase ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// Confirms the caller is a logged-in staff member by asking Supabase Auth to
// validate their JWT (the same token the app already sends to /api/tracking-refresh).
async function verifyUser(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${m[1]}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || "";
}

// Best-effort filter for email security scanners, link previewers and crawlers.
// This is a heuristic: some scanners disguise themselves as normal browsers,
// so false "viewed" events can still occasionally happen.
const BOT_RE = new RegExp(
  [
    "bot", "crawl", "spider", "slurp", "preview", "scan", "monitor", "fetch",
    "curl", "wget", "python", "java/", "go-http", "okhttp", "httpclient", "headless", "phantom", "lighthouse",
    "safelinks", "microsoft office", "ms-office", "office365", "outlook-ios-link", "barracuda", "proofpoint",
    "mimecast", "symantec", "trend ?micro", "forcepoint", "zscaler", "urlscan", "sophos", "fireeye",
    "mailscanner", "whatsapp", "skype", "slack", "twitter", "linkedin", "facebookexternalhit", "pingdom", "uptime",
  ].join("|"),
  "i"
);
function isBot(ua) {
  if (!ua || ua.length < 10) return true;
  return BOT_RE.test(ua);
}

function hashIp(ip, salt) {
  return crypto.createHash("sha256").update(`${ip}:${salt}`).digest("hex").slice(0, 32);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Backstop sanitiser for the stored snapshot. The REAL protection is the strict
// Content-Security-Policy on the public page (no scripts can run from the snapshot);
// this just removes obviously dangerous markup as well.
function sanitizeSnapshot(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<(script|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  h = h.replace(/<\/?(script|iframe|object|embed|noscript|template|base|meta|link|form|input|button|textarea|select)\b[^>]*>/gi, "");
  h = h.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  h = h.replace(
    /\b(href|src|xlink:href|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|data:(?!image\/))[^"']*\2/gi,
    '$1=$2#$2'
  );
  return h;
}

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `https://${host}` : "";
}

function newToken() {
  return crypto.randomBytes(24).toString("base64url"); // 192 bits, 32 URL-safe chars
}

module.exports = {
  SUPABASE_URL, LINK_LIFETIME_DAYS, MAX_SNAPSHOT_BYTES, ACCEPT_TERMS_TEXT,
  sb, verifyUser, readJson, send, clientIp, isBot, hashIp, esc,
  sanitizeSnapshot, publicBaseUrl, newToken,
};
