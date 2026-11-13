// Local logic test. Replaces global fetch with a tiny in-memory fake of the few
// Supabase calls the API makes. It checks OUR handler logic; it does NOT prove that
// real PostgREST/Supabase accepts the same queries (that needs a live test).
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
const assert = require("assert");

const shares = []; const views = [];
const log = [];
let idc = 0;

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const json = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? "" : JSON.stringify(data)), json: async () => data });
  log.push(`${method} ${u.pathname}${u.search}`);

  if (u.pathname === "/auth/v1/user") {
    return opts.headers.Authorization === "Bearer good-jwt" ? json(200, { id: "u1", email: "duncan@test.com" }) : json(401, {});
  }
  const p = u.searchParams;
  const eq = (k) => (p.get(k) || "").replace(/^eq\./, "");

  if (u.pathname === "/rest/v1/quote_shares") {
    if (method === "GET" && p.get("select") === "version") {
      const rows = shares.filter(s => s.quote_id === eq("quote_id")).sort((a, b) => b.version - a.version).slice(0, 1).map(s => ({ version: s.version }));
      return json(200, rows);
    }
    if (method === "GET") return json(200, shares.filter(s => s.token === eq("token")));
    if (method === "POST") { const row = { id: "id" + ++idc, view_count: 0, accepted_at: null, first_viewed_at: null, last_viewed_at: null, ...body }; shares.push(row); return json(201, [row]); }
    if (method === "PATCH") {
      let m = shares;
      if (p.get("quote_id")) m = m.filter(s => s.quote_id === eq("quote_id"));
      if (p.get("token")) m = m.filter(s => s.token === eq("token"));
      if (p.get("status")) m = m.filter(s => s.status === eq("status"));
      if (p.get("accepted_at") === "is.null") m = m.filter(s => !s.accepted_at);
      if (p.get("expires_at")) m = m.filter(s => new Date(s.expires_at) > new Date(p.get("expires_at").replace(/^gt\./, "")));
      m.forEach(s => Object.assign(s, body));
      return opts.headers.Prefer === "return=minimal" ? json(204) : json(200, m);
    }
  }
  if (u.pathname === "/rest/v1/rpc/record_quote_view") {
    const s = shares.find(x => x.token === body.p_token);
    if (!s || s.status === "revoked" || (new Date(s.expires_at) < new Date() && !s.accepted_at)) return json(200, { recorded: false });
    const recent = views.find(v => v.share === s.id && v.ip === body.p_ip_hash && Date.now() - v.t < 60000);
    if (recent) return json(200, { recorded: false });
    views.push({ share: s.id, ip: body.p_ip_hash, t: Date.now() });
    const first = !s.first_viewed_at; s.view_count++; s.last_viewed_at = new Date().toISOString(); s.first_viewed_at = s.first_viewed_at || s.last_viewed_at;
    return json(200, { recorded: true, first_view: first, view_count: s.view_count });
  }
  return json(404, { message: "unhandled " + u.pathname });
};

function call(handler, { method = "GET", headers = {}, body, query } = {}) {
  return new Promise(async (resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b || "" }); } };
    await handler({ method, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36", "x-forwarded-for": "1.2.3.4", host: "austral-rosy.vercel.app", ...headers }, body, query, socket: {} }, res);
  });
}

(async () => {
  const create = require("../api/quote-share-create");
  const page = require("../api/quote-page");
  const view = require("../api/quote-view");
  const accept = require("../api/quote-accept");
  const goodAuth = { authorization: "Bearer good-jwt" };
  const snap = `<div style="x"><h2>Quote QU-1004</h2><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a><a href="https://example.com/terms.pdf">Terms</a><table><tr><td>Line</td></tr></table></div>`;
  const base = { quoteId: "abc", quoteNumber: "QU-1004", recipientName: "Jane Smith", recipientEmail: "jane@example.com", brand: "austral", total: 100000, snapshotHtml: snap };

  // 1. auth + validation
  assert.strictEqual((await call(create, { method: "POST", body: base })).status, 401, "create requires login");
  assert.strictEqual((await call(create, { method: "POST", headers: { authorization: "Bearer nope" }, body: base })).status, 401);
  assert.strictEqual((await call(create, { method: "POST", headers: goodAuth, body: { ...base, recipientName: "" } })).status, 400);
  assert.strictEqual((await call(create, { method: "POST", headers: goodAuth, body: { ...base, recipientEmail: "nope" } })).status, 400);
  assert.strictEqual((await call(create, { method: "GET", headers: goodAuth })).status, 405);

  // 2. create v1
  const c1 = await call(create, { method: "POST", headers: goodAuth, body: base });
  assert.strictEqual(c1.status, 200, c1.body);
  const r1 = JSON.parse(c1.body);
  assert.strictEqual(r1.version, 1);
  assert.match(r1.url, /^https:\/\/austral-rosy\.vercel\.app\/q\/[A-Za-z0-9_-]{32}$/);
  const days = (new Date(r1.expiresAt) - Date.now()) / 864e5;
  assert.ok(days > 13.99 && days <= 14, "expires in 14 days");
  assert.ok(!shares[0].snapshot_html.includes("<script"), "script stripped");
  assert.ok(!/onerror/i.test(shares[0].snapshot_html), "event handler stripped");
  assert.ok(!/javascript:/i.test(shares[0].snapshot_html), "javascript: url stripped");
  assert.ok(shares[0].snapshot_html.includes("https://example.com/terms.pdf"), "good link kept");

  // 3. public page
  const pg = await call(page, { query: { token: r1.token } });
  assert.strictEqual(pg.status, 200);
  assert.ok(pg.body.includes("Quote QU-1004") && pg.body.includes("Accept this quote"));
  assert.match(pg.headers["content-security-policy"], /script-src 'nonce-/);
  assert.match(pg.headers["x-robots-tag"], /noindex/);
  assert.strictEqual((await call(page, { query: { token: "short" } })).status, 404);
  assert.strictEqual((await call(page, { query: { token: "A".repeat(32) } })).status, 404, "unknown token -> generic 404");

  // 4. views: bot ignored, human counted, 60s dedupe
  const botUA = "Mozilla/5.0 Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)";
  await call(view, { method: "POST", headers: { "user-agent": botUA }, body: { token: r1.token } });
  assert.strictEqual(shares[0].view_count, 0, "bot not counted");
  await call(view, { method: "POST", headers: { "user-agent": "curl/8.0" }, body: { token: r1.token } });
  assert.strictEqual(shares[0].view_count, 0, "curl not counted");
  const v1 = await call(view, { method: "POST", body: { token: r1.token } });
  assert.strictEqual(v1.status, 204);
  assert.strictEqual(shares[0].view_count, 1, "human counted");
  assert.ok(shares[0].first_viewed_at && shares[0].last_viewed_at);
  await call(view, { method: "POST", body: { token: r1.token } });
  assert.strictEqual(shares[0].view_count, 1, "same ip within 60s deduped");
  await call(view, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, body: { token: r1.token } });
  assert.strictEqual(shares[0].view_count, 2, "different visitor counted");
  assert.strictEqual((await call(view, { method: "POST", body: { token: "garbage" } })).status, 204, "bad token silently ignored");

  // 5. accept validations
  assert.strictEqual((await call(accept, { method: "POST", body: { token: r1.token, name: "Jane Smith", agreed: false } })).status, 400, "must tick box");
  assert.strictEqual((await call(accept, { method: "POST", body: { token: r1.token, name: "J", agreed: true } })).status, 400, "name required");

  // 6. re-send -> v2, v1 superseded and can't be accepted but still viewable
  const c2 = await call(create, { method: "POST", headers: goodAuth, body: { ...base, snapshotHtml: snap + "<p>revised</p>" } });
  const r2 = JSON.parse(c2.body);
  assert.strictEqual(r2.version, 2);
  assert.strictEqual(shares[0].status, "superseded");
  const old = await call(page, { query: { token: r1.token } });
  assert.strictEqual(old.status, 200);
  assert.ok(old.body.includes("newer version") && !old.body.includes("Accept this quote"), "old link: banner, no accept panel");
  assert.strictEqual((await call(accept, { method: "POST", body: { token: r1.token, name: "Jane Smith", agreed: true } })).status, 409, "superseded can't be accepted");

  // 7. accept v2, once only
  const a = await call(accept, { method: "POST", body: { token: r2.token, name: "  Jane   Smith ", agreed: true } });
  assert.strictEqual(a.status, 200, a.body);
  assert.strictEqual(shares[1].accepted_name, "Jane Smith");
  assert.ok(shares[1].accepted_terms_text.includes("payment milestones"));
  assert.strictEqual((await call(accept, { method: "POST", body: { token: r2.token, name: "Jane Smith", agreed: true } })).status, 409, "second acceptance refused");
  const after = await call(page, { query: { token: r2.token } });
  assert.ok(after.body.includes("Quote accepted") && !after.body.includes("Accept this quote"));

  // 8. expiry
  const c3 = JSON.parse((await call(create, { method: "POST", headers: goodAuth, body: { ...base, quoteId: "other" } })).body);
  shares.find(s => s.token === c3.token).expires_at = new Date(Date.now() - 1000).toISOString();
  const exp = await call(page, { query: { token: c3.token } });
  assert.strictEqual(exp.status, 410); assert.ok(!exp.body.includes("Quote QU-1004"), "expired quote content hidden");
  assert.strictEqual((await call(accept, { method: "POST", body: { token: c3.token, name: "Jane Smith", agreed: true } })).status, 409, "expired can't be accepted");
  const before = shares.find(s => s.token === c3.token).view_count;
  await call(view, { method: "POST", headers: { "x-forwarded-for": "5.5.5.5" }, body: { token: c3.token } });
  assert.strictEqual(shares.find(s => s.token === c3.token).view_count, before, "expired view not counted");
  // accepted quote stays viewable after expiry
  shares[1].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual((await call(page, { query: { token: r2.token } })).status, 200, "accepted quote viewable after expiry");

  // 9. XSS in names is escaped on the page
  shares[1].accepted_name = `<img src=x onerror=alert(1)>`;
  const xss = await call(page, { query: { token: r2.token } });
  assert.ok(!xss.body.includes("<img src=x onerror"), "accepted name escaped");

  console.log("ALL CHECKS PASSED (" + log.length + " fake Supabase calls)");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
