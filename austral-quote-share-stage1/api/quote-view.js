// POST /api/quote-view   (public — called by a small script on the customer's quote page)
// Body: { token }
// Counts a view unless the request looks like a scanner/bot. Always answers 204 so
// nothing about the link's state is revealed.

const Q = require("./_lib/quoteShare");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return Q.send(res, 405, { error: "Method not allowed" });
  const done = () => { res.statusCode = 204; res.setHeader("Cache-Control", "no-store"); res.end(); };

  try {
    const b = await Q.readJson(req);
    const token = String(b.token || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return done();

    const ua = String(req.headers["user-agent"] || "");
    if (Q.isBot(ua)) return done();

    await Q.sb("rpc/record_quote_view", {
      method: "POST",
      body: {
        p_token: token,
        p_ip_hash: Q.hashIp(Q.clientIp(req), token),
        p_user_agent: ua,
      },
    });
  } catch (err) {
    console.error("quote-view failed:", err.message);
  }
  return done();
};
