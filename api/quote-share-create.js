// POST /api/quote-share-create   (staff only — requires the app's Supabase login token)
// Body: { quoteId, quoteNumber, recipientName, recipientEmail, brand?, total?, snapshotHtml }
// Creates a new frozen share (version n+1), marks older active shares as superseded,
// and returns the customer URL.

const Q = require("./_lib/quoteShare");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return Q.send(res, 405, { error: "Method not allowed" });

  const user = await Q.verifyUser(req);
  if (!user) return Q.send(res, 401, { error: "Not signed in" });

  try {
    const b = await Q.readJson(req);
    const quoteId = String(b.quoteId || "").trim();
    const quoteNumber = String(b.quoteNumber || "").trim();
    const recipientName = String(b.recipientName || "").trim().slice(0, 200);
    const recipientEmail = String(b.recipientEmail || "").trim().slice(0, 254);
    const brand = ["austral", "platinum"].includes(b.brand) ? b.brand : null;
    const snapshot = Q.sanitizeSnapshot(b.snapshotHtml);
    const total = Number.isFinite(Number(b.total)) ? Number(b.total) : null;

    if (!quoteId) return Q.send(res, 400, { error: "quoteId is required" });
    if (!recipientName) return Q.send(res, 400, { error: "Recipient name is required" });
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return Q.send(res, 400, { error: "Recipient email looks invalid" });
    }
    if (snapshot.length < 50) return Q.send(res, 400, { error: "Quote snapshot is empty" });
    if (Buffer.byteLength(snapshot, "utf8") > Q.MAX_SNAPSHOT_BYTES) {
      return Q.send(res, 413, { error: "Quote snapshot is too large" });
    }

    const qid = encodeURIComponent(quoteId);
    const latest = await Q.sb(`quote_shares?quote_id=eq.${qid}&select=version&order=version.desc&limit=1`);
    const version = (latest && latest[0] ? Number(latest[0].version) : 0) + 1;

    // Older links stay viewable (for comparison) but can no longer be accepted.
    await Q.sb(`quote_shares?quote_id=eq.${qid}&status=eq.active`, {
      method: "PATCH",
      body: { status: "superseded" },
      prefer: "return=minimal",
    });

    const token = Q.newToken();
    const expiresAt = new Date(Date.now() + Q.LINK_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const rows = await Q.sb("quote_shares", {
      method: "POST",
      prefer: "return=representation",
      body: {
        token,
        quote_id: quoteId,
        quote_number: quoteNumber || null,
        version,
        status: "active",
        brand,
        recipient_name: recipientName,
        recipient_email: recipientEmail || null,
        total,
        snapshot_html: snapshot,
        expires_at: expiresAt,
        created_by: user.email || user.id,
      },
    });
    const row = Array.isArray(rows) ? rows[0] : rows;

    return Q.send(res, 200, {
      ok: true,
      id: row && row.id,
      token,
      version,
      expiresAt,
      url: `${Q.publicBaseUrlFor(req, brand)}/q/${token}`,
    });
  } catch (err) {
    console.error("quote-share-create failed:", err.message, err.detail || "");
    return Q.send(res, 500, { error: "Could not create the quote link" });
  }
};
