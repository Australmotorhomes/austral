// Read-only diagnostic: look up an item by product code, show its category,
// and list every quote/PO line item that references it — so we can see
// exactly why it is or isn't showing up in Stock Movement.
//
// USAGE (cmd.exe):
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_SERVICE_ROLE_KEY=xxxx
//   node lookup-item.mjs SAV45CUST
//
// USAGE (Mac/Linux):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node lookup-item.mjs SAV45CUST

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const productCode = process.argv[2];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}
if (!productCode) {
  console.error("Missing product code. Example: node lookup-item.mjs SAV45CUST");
  process.exit(1);
}

async function supabaseREST(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const items = await supabaseREST("items?select=*");
  const matches = items.filter((i) => (i.productCode || i.product_code || "").toUpperCase() === productCode.toUpperCase());

  if (!matches.length) {
    console.log(`No item found with product code "${productCode}". It may have been deleted from the catalog, or a quote/PO line is matching it by description text rather than a live itemId.`);
    return;
  }

  matches.forEach((item, i) => {
    console.log(`Item ${i + 1} — id: ${item.id}`);
    console.log(`  productCode: ${item.productCode || item.product_code}`);
    console.log(`  name: ${item.name || "(none)"}`);
    console.log(`  description: ${item.description || "(none)"}`);
    console.log(`  category: ${item.category || "(none set)"}`);
    console.log(`  → ${item.category === "Chassis & Structure" ? "IS in Chassis & Structure — will show in Stock Movement" : "NOT in Chassis & Structure — should be excluded from Stock Movement"}`);
    console.log("");
  });

  const itemIds = matches.map((i) => i.id);

  const quotes = await supabaseREST("quotes?select=*");
  const referencingQuotes = quotes.filter((q) => (q.lines || []).some((l) => itemIds.includes(l.itemId)));
  console.log(`Quotes referencing this item: ${referencingQuotes.length}`);
  referencingQuotes.forEach((q) => {
    const milestones = q.paymentMilestones || q.payment_milestones || [];
    const first = milestones[0];
    console.log(`  - ${q.number || q.id} — party: ${q.party || "Unknown"}, status: ${q.status}, first milestone paid: ${first?.paid ? `yes (${first.paidDate || first.due})` : "no"}`);
  });

  const pos = await supabaseREST("purchase_orders?select=*");
  const referencingPOs = pos.filter((po) => (po.lines || []).some((l) => itemIds.includes(l.itemId)));
  console.log(`\nPurchase Orders referencing this item: ${referencingPOs.length}`);
  referencingPOs.forEach((po) => {
    const poNum = String(po.number || "").replace(/^PO-?/i, "");
    console.log(`  - PO-${poNum} — party: ${po.party || "Unknown"}, status: ${po.status}, date: ${po.date || po.createdAt || "—"}`);
  });

  if (referencingQuotes.length && !referencingPOs.length) {
    console.log(`\n→ This matches the symptom exactly: a quote sold this item (contributing the OUT=1), but no Purchase Order in your system has a matching line item at all — hence IN=0, and a negative on-hand count for this code.`);
  }
}

main().catch((err) => {
  console.error("Lookup failed:", err);
  process.exit(1);
});
