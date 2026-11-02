// POST /api/tracking-refresh   body: { poId }   (signed-in users only)
// Refreshes one PO's live ETA on demand (the "Refresh" button on Shipments due).
const { refreshOne, verifyUser, sbHeaders, SUPABASE_URL } = require("./_tracking");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    if (!(await verifyUser(req))) return res.status(401).json({ error: "Not signed in" });
    const poId = req.body && req.body.poId;
    if (!poId) return res.status(400).json({ error: "poId required" });
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/purchase_orders?select=id,number,shipping_line,bill_of_lading,container_number&id=eq.${encodeURIComponent(poId)}`,
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: "PO not found" });
    const out = await refreshOne(rows[0]);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
