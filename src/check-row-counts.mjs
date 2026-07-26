// Checks the EXACT total row count of the customers table (and a couple of
// others) using Supabase's "Prefer: count=exact" header, without fetching all
// the data. This tells us whether the table exceeds PostgREST's default
// 1000-row response cap — which would mean the app's own single unpaginated
// fetch (loadAllData -> supabaseREST) could be silently missing or
// inconsistently returning rows.
//
// USAGE (cmd.exe):
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_SERVICE_ROLE_KEY=xxxx
//   node check-row-counts.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}

async function getExactCount(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    method: "HEAD",
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Prefer": "count=exact",
    },
  });
  if (!res.ok) {
    throw new Error(`HEAD ${table} failed: ${res.status}`);
  }
  const contentRange = res.headers.get("content-range"); // format: "0-999/1234"
  const total = contentRange ? parseInt(contentRange.split("/")[1], 10) : null;
  return total;
}

async function main() {
  const tables = ["customers", "quotes", "purchase_orders", "items", "suppliers", "crm_prospects"];
  for (const table of tables) {
    try {
      const total = await getExactCount(table);
      const flag = total !== null && total > 1000 ? "  ⚠ EXCEEDS 1000-row default page size" : "";
      console.log(`${table}: ${total === null ? "unknown (no count header returned)" : total} rows${flag}`);
    } catch (e) {
      console.log(`${table}: error checking count — ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Count check failed:", err);
  process.exit(1);
});
