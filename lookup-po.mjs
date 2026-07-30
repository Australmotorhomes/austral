// Read-only diagnostic: look up a purchase order by its number and print its
// raw fields — especially consolidated_member_ids and consolidated_group_id —
// to see whether the app actually considers it a consolidated PO or not.
//
// USAGE (cmd.exe):
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_SERVICE_ROLE_KEY=xxxx
//   node lookup-po.mjs 5001
//
// USAGE (Mac/Linux):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node lookup-po.mjs 5001

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const searchNum = process.argv[2];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}
if (!searchNum) {
  console.error("Missing PO number. Example: node lookup-po.mjs 5001");
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
  const pos = await supabaseREST("purchase_orders?select=*");
  const term = String(searchNum).toUpperCase().replace(/^PO-?/, "");
  const matches = pos.filter((po) => String(po.number || "").toUpperCase().replace(/^PO-?/, "").includes(term));

  if (!matches.length) {
    console.log(`No PO found matching "${searchNum}".`);
    return;
  }

  matches.forEach((po, i) => {
    console.log(`PO ${i + 1} — id: ${po.id}`);
    console.log(`  number: ${po.number}`);
    console.log(`  party: ${po.party || "(none)"}`);
    console.log(`  status: ${po.status}`);
    console.log(`  archived: ${po.archived}`);
    console.log(`  consolidated_group_id: ${po.consolidated_group_id || "(none)"}`);
    console.log(`  consolidated_member_ids (raw): ${JSON.stringify(po.consolidated_member_ids)}`);
    console.log(`  consolidated_member_ids type: ${typeof po.consolidated_member_ids}`);
    console.log(`  lines count: ${(po.lines || []).length}`);
    (po.lines || []).slice(0, 5).forEach((l, li) => {
      console.log(`    line ${li + 1}: desc="${(l.desc || l.description || "").slice(0, 60)}" qty=${l.qty || l.quantity} price=${l.price || l.unitPrice || l.cost}`);
    });
    console.log("");
  });

  if (matches.length > 1) {
    console.log(`⚠ Multiple POs matched "${searchNum}" — if consolidatedMemberIds references one of these by id, check which specific id it points to.`);
  }
}

main().catch((err) => {
  console.error("Lookup failed:", err);
  process.exit(1);
});
