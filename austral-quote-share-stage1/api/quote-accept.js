// POST /api/quote-accept   (public)
// Body: { token, name, agreed: true }
// Records the customer's acceptance, once, on a current (active, unexpired) link.
// Stage 1 only RECORDS the acceptance. It does not change the quote's status in the
// app — you still confirm with the existing "Accept Quote" button.

const Q = require("./_lib/quoteShare");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return Q.send(res, 405, { error: "Method not allowed" });

  try {
    const b = await Q.readJson(req);
    const token = String(b.token || "");
    const name = String(b.name || "").trim().replace(/\s+/g, " ");

    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return Q.send(res, 404, { error: "Link not found" });
    if (b.agreed !== true) return Q.send(res, 400, { error: "Please tick the box to accept the terms." });
    if (name.length < 2 || name.length > 100) {
      return Q.send(res, 400, { error: "Please type your full name." });
    }

    // Single conditional UPDATE = atomic: only succeeds if the link is still current
    // and has not already been accepted. Empty result => not allowed.
    const nowIso = new Date().toISOString();
    const rows = await Q.sb(
      `quote_shares?token=eq.${encodeURIComponent(token)}` +
        `&status=eq.active&accepted_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}` +
        `&select=id,quote_number,version`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          accepted_at: nowIso,
          accepted_name: name,
          accepted_ip: Q.clientIp(req).slice(0, 64),
          accepted_user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
          accepted_terms_text: Q.ACCEPT_TERMS_TEXT,
        },
      }
    );

    if (!rows || !rows.length) {
      return Q.send(res, 409, {
        error: "This quote can no longer be accepted online (it may have expired, been replaced by a newer version, or already been accepted).",
      });
    }
    return Q.send(res, 200, { ok: true, acceptedAt: nowIso, name });
  } catch (err) {
    console.error("quote-accept failed:", err.message, err.detail || "");
    return Q.send(res, 500, { error: "Sorry, something went wrong. Please try again or contact us." });
  }
};
