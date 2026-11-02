// Shared helpers for the DataLoop tracking functions (Vercel serverless, Node).
// Files starting with "_" in /api are not exposed as routes.

const DATALOOP_URL = "https://api.datalooplabs.com/api/v1/tracking";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dpapwmittcowsrwwsajo.supabase.co";

// Same statuses the Dashboard "Shipments due" list treats as finished.
const DONE_STATUSES = ["Cancelled", "Received", "Archived"];

// ---------------------------------------------------------------------------
// VERIFY AGAINST A REAL RESPONSE.
// The only response field confirmed from the DataLoop docs screenshot is
//   data.route.pod.predictive_eta   (DataLoop's own estimate; only present when
//                                    the carrier gave no arrival date).
// The carrier's own arrival date lives somewhere else in the response and its
// path is NOT confirmed. Put the confirmed path(s) here once checked against a
// real response (tracking_raw column / the "debug" refresh); they are tried in
// order, before falling back to predictive_eta.
// Example shape (NOT confirmed): ["data.route.pod.date"]
// ---------------------------------------------------------------------------
const CARRIER_ETA_PATHS = ["data.route.pod.date"];
const PREDICTIVE_ETA_PATH = "data.route.pod.predictive_eta";

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

// Accepts "YYYY-MM-DD..." strings (or anything Date can parse) -> "YYYY-MM-DD" or null.
function toDateOnly(v) {
  if (!v || typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (m) return m[1];
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function extractEta(json) {
  for (const p of CARRIER_ETA_PATHS) {
    const d = toDateOnly(getPath(json, p));
    if (d) return { eta: d, source: "carrier" };
  }
  const pred = toDateOnly(getPath(json, PREDICTIVE_ETA_PATH));
  if (pred) return { eta: pred, source: "predictive" };
  return { eta: null, source: null };
}

// Container number is preferred (type CT + shipping line). Falls back to the bill of lading (type BL).
function buildRequest(po) {
  const container = (po.container_number || "").trim();
  const bl = (po.bill_of_lading || "").trim();
  const line = (po.shipping_line || "").trim();
  if (!container && !bl) return null;
  const body = {
    number: container || bl,
    mode: "ocean",
    type: container ? "CT" : "BL",
    sealine: line || "auto",
    include_predictive_eta: true,
  };
  return body;
}

async function callDataLoop(body) {
  const key = process.env.DATALOOP_API_KEY;
  if (!key) throw new Error("DATALOOP_API_KEY is not set");
  const res = await fetch(DATALOOP_URL, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return json;
}

function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

// Looks up one PO row, calls DataLoop, writes the result back. Never throws; returns a summary.
async function refreshOne(po) {
  const req = buildRequest(po);
  if (!req) return { id: po.id, skipped: "no container or bill of lading" };
  const patch = { tracking_updated_at: new Date().toISOString() };
  let summary;
  try {
    const json = await callDataLoop(req);
    const { eta, source } = extractEta(json);
    patch.tracking_raw = json;
    patch.tracking_error = null;
    if (eta) {
      patch.live_eta = eta; patch.live_eta_source = source; patch.tracking_status = "ok";
    } else {
      // Keep any previous live_eta rather than blanking it on a day with no date.
      patch.tracking_status = "no_eta";
    }
    summary = { id: po.id, status: patch.tracking_status, eta, source };
  } catch (e) {
    patch.tracking_status = "error";
    patch.tracking_error = String(e.message || e).slice(0, 300);
    summary = { id: po.id, status: "error", error: patch.tracking_error };
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/purchase_orders?id=eq.${encodeURIComponent(po.id)}`, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) summary.saveError = `Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`;
  return { ...summary, patch: { live_eta: patch.live_eta, live_eta_source: patch.live_eta_source, tracking_updated_at: patch.tracking_updated_at, tracking_status: patch.tracking_status, tracking_error: patch.tracking_error } };
}

async function fetchActivePOs(extraFilter = "") {
  const notIn = `(${DONE_STATUSES.join(",")})`;
  const url = `${SUPABASE_URL}/rest/v1/purchase_orders?select=id,number,shipping_line,bill_of_lading,container_number` +
    `&shipping_type=eq.International&status=not.in.${notIn}${extraFilter}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Confirms the caller is a signed-in app user (stops strangers spending DataLoop credits).
async function verifyUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) { console.log("verifyUser: no Bearer header"); return false; }
  const anon = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  console.log("verifyUser: anon key present:", !!anon);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: anon || "", Authorization: auth } });
  if (!r.ok) console.log("verifyUser: Supabase said", r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

module.exports = { refreshOne, fetchActivePOs, verifyUser, sbHeaders, SUPABASE_URL, extractEta };
