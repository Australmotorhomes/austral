// GET /api/tracking-cron   — called once a day by Vercel Cron (see vercel.json).
// Refreshes every active international PO that has a container or bill of lading.
const { refreshOne, fetchActivePOs } = require("./_tracking");

module.exports = async (req, res) => {
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const pos = await fetchActivePOs();
    const results = [];
    for (const po of pos) results.push(await refreshOne(po)); // sequential: gentle on the API
    return res.status(200).json({ count: results.length, results: results.map(({ patch, ...r }) => r) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
