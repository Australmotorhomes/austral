// Shared helpers for the DataLoop tracking functions (Vercel serverless, Node).
// Files starting with "_" in /api are not exposed as routes.

const DATALOOP_URL = "https://api.datalooplabs.com/api/v1/tracking";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dpapwmittcowsrwwsajo.supabase.co";

// Same statuses the Dashboard "Shipments due" list treats as finished.
const DONE_STATUSES = ["Cancelled", "Received", "Archived"];

// ---------------------------------------------------------------------------
// Response paths (confirmed against a real PIL ocean response):
//   data.route.pod.date            carrier's arrival date at the port of discharge (Brisbane)
//   data.route.pod.predictive_eta  DataLoop's own estimate, used only if the carrier gave no date
// Departure date (port of loading). By analogy with "pod" this should be
//   data.route.pol.date
// but it has NOT been checked against a real response yet: look in the tracking_raw
// column for the loading port's date and adjust the path below if it differs.
// ---------------------------------------------------------------------------
const CARRIER_ETA_PATHS = ["data.route.pod.date"];
const PREDICTIVE_ETA_PATH = "data.route.pod.predictive_eta";
const DEPARTURE_PATHS = ["data.route.pol.date"];

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

function extractDeparture(json) {
  for (const p of DEPARTURE_PATHS) {
    const d = toDateOnly(getPath(json, p));
    if (d) return d;
  }
  return null;
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
    const departure = extractDeparture(json);
    if (departure) patch.departure_date = departure; // keep the previous value if this response has none
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
  const save = (body) => fetch(`${SUPABASE_URL}/rest/v1/purchase_orders?id=eq.${encodeURIComponent(po.id)}`, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  let r = await save(patch);
  let savedDeparture = patch.departure_date;
  if (!r.ok && patch.departure_date !== undefined) {
    // The departure_date column may not exist yet: retry without it so the ETA still saves.
    const { departure_date, ...rest } = patch;
    savedDeparture = undefined;
    r = await save(rest);
  }
  if (!r.ok) summary.saveError = `Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`;
  return { ...summary, patch: { live_eta: patch.live_eta, live_eta_source: patch.live_eta_source, departure_date: savedDeparture, tracking_updated_at: patch.tracking_updated_at, tracking_status: patch.tracking_status, tracking_error: patch.tracking_error } };
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
  if (!auth.startsWith("Bearer ")) return false;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: anon || "", Authorization: auth } });
  return r.ok;
}

module.exports = { refreshOne, fetchActivePOs, verifyUser, sbHeaders, SUPABASE_URL, extractEta };
