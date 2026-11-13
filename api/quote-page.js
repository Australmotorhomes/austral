// GET /q/<token>  (rewritten to /api/quote-page?token=<token> by vercel.json)
// Public, customer-facing page. Shows the frozen quote snapshot, and — if the link is
// current — the "accept" panel. Unknown / revoked / expired links show a generic page
// (no quote content, no hint about whether the token ever existed).

const crypto = require("crypto");
const Q = require("./_lib/quoteShare");

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#f3eee4;color:#2b2018;font-family:Georgia,'Times New Roman',serif;line-height:1.5}
.wrap{max-width:860px;margin:0 auto;padding:16px}
.banner{border-radius:8px;padding:12px 14px;margin:0 0 14px;font-size:14px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.banner.warn{background:#fff6e0;border:1px solid #e6cf94;color:#6b4e0a}
.banner.ok{background:#eaf4e4;border:1px solid #b9d6a8;color:#2f5a1f}
.paper{background:#fff;border:1px solid #d3c9b8;border-radius:10px;padding:26px;overflow-x:auto}
.paper table{width:100%;border-collapse:collapse}
.paper img{max-width:100%;height:auto}
.accept{background:#fff;border:1px solid #d3c9b8;border-radius:10px;padding:20px;margin-top:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px}
.accept h2{margin:0 0 10px;font-family:Georgia,serif;font-size:20px}
.accept label.chk{display:flex;gap:10px;align-items:flex-start;margin:12px 0;cursor:pointer}
.accept input[type=checkbox]{width:20px;height:20px;margin-top:2px;flex:none}
.accept input[type=text]{width:100%;padding:10px;border:1px solid #bfb3a0;border-radius:6px;font-size:16px}
.accept button{background:#b5552b;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:16px;cursor:pointer;margin-top:12px}
.accept button:disabled{opacity:.5;cursor:not-allowed}
.err{color:#a3442e;margin-top:10px;font-size:14px}
.small{font-size:12px;color:#8a7a66;margin-top:8px}
.center{max-width:560px;margin:12vh auto;padding:0 20px;text-align:center}
@media (max-width:600px){.paper{padding:14px}}
`;

function shell(nonce, title, inner, script) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${Q.esc(title)}</title><style>${STYLE}</style></head><body>${inner}
${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function setHeaders(res, nonce) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The snapshot is stored HTML. This policy means no script from it can ever run.
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
}

function genericPage(res, nonce, status, heading, message) {
  setHeaders(res, nonce);
  res.statusCode = status;
  res.end(shell(nonce, heading, `<div class="center"><h1>${Q.esc(heading)}</h1><p>${Q.esc(message)}</p></div>`));
}

const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane", day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "long", year: "numeric" });

module.exports = async function handler(req, res) {
  const nonce = crypto.randomBytes(16).toString("base64");
  if (req.method !== "GET" && req.method !== "HEAD") {
    return genericPage(res, nonce, 405, "Not available", "This page cannot be displayed.");
  }

  const token = String((req.query && req.query.token) || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    return genericPage(res, nonce, 404, "Quote not found", "This link is not valid. Please check the link in your email, or contact the sender.");
  }

  let share;
  try {
    const rows = await Q.sb(`quote_shares?token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
    share = rows && rows[0];
  } catch (err) {
    console.error("quote-page lookup failed:", err.message);
    return genericPage(res, nonce, 500, "Temporarily unavailable", "Sorry, we could not load this quote right now. Please try again shortly.");
  }

  if (!share || share.status === "revoked") {
    return genericPage(res, nonce, 404, "Quote not found", "This link is not valid. Please check the link in your email, or contact the sender.");
  }

  const now = Date.now();
  const expired = new Date(share.expires_at).getTime() < now;
  const accepted = !!share.accepted_at;

  // Expired and never accepted: do not show the quote at all.
  if (expired && !accepted) {
    return genericPage(
      res, nonce, 410, "This quote link has expired",
      "For your security, quote links expire after 14 days. Please contact the sender to request an updated quote."
    );
  }

  // ?preview=1 is used by staff ("Preview as customer"). It never records a view and
  // hides the accept panel, so checking a link yourself can't trigger notifications
  // or an accidental acceptance. It is only a courtesy flag: the public could add it
  // too, which at worst means their own view isn't counted.
  const preview = String((req.query && req.query.preview) || "") === "1";

  const superseded = share.status === "superseded";
  const canAccept = !accepted && !superseded && !expired && !preview;

  let banner = "";
  if (preview) {
    banner = `<div class="banner warn"><strong>Staff preview.</strong> This visit is not counted as a customer view.${accepted ? "" : " The accept panel is hidden."}</div>`;
  } else if (accepted) {
    banner = `<div class="banner ok"><strong>Quote accepted.</strong> Accepted by ${Q.esc(share.accepted_name)} on ${Q.esc(fmtDateTime(share.accepted_at))}. We will be in touch about the next steps.</div>`;
  } else if (superseded) {
    banner = `<div class="banner warn"><strong>A newer version of this quote has been issued.</strong> This version can no longer be accepted online. Please use the most recent link we sent you, or contact us.</div>`;
  } else {
    banner = `<div class="banner warn">This quote link is valid until ${Q.esc(fmtDate(share.expires_at))}.</div>`;
  }

  const acceptPanel = canAccept
    ? `<div class="accept" id="acceptPanel">
  <h2>Accept this quote</h2>
  <label class="chk"><input type="checkbox" id="agree"><span>${Q.esc(Q.ACCEPT_TERMS_TEXT)}</span></label>
  <label for="nm">Your full name</label>
  <input type="text" id="nm" autocomplete="name" maxlength="100" placeholder="Type your full name">
  <button id="acceptBtn" disabled>Accept quote</button>
  <div class="err" id="err" role="alert"></div>
  <div class="small">Typing your name and ticking the box is your electronic acceptance of this quote. The date and time are recorded.</div>
</div>`
    : "";

  const script = `
(function(){
  var token=${JSON.stringify(token)};
  function ping(){try{fetch('/api/quote-view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token}),keepalive:true});}catch(e){}}
  var sent=false;
  var PREVIEW=${preview ? 'true' : 'false'};
  function fire(){ if(sent||PREVIEW) return; sent=true; ping(); }
  function arm(){ setTimeout(function(){ if(document.visibilityState==='visible') fire(); else document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') fire(); }); },2000); }
  if(document.readyState==='complete') arm(); else window.addEventListener('load',arm);

  var agree=document.getElementById('agree'), nm=document.getElementById('nm'), btn=document.getElementById('acceptBtn'), err=document.getElementById('err');
  if(!btn) return;
  function upd(){ btn.disabled=!(agree.checked && nm.value.trim().length>=2); }
  agree.addEventListener('change',upd); nm.addEventListener('input',upd);
  btn.addEventListener('click',function(){
    btn.disabled=true; err.textContent='';
    fetch('/api/quote-accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,name:nm.value,agreed:agree.checked})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(o){
        if(o.ok){ document.getElementById('acceptPanel').innerHTML='<h2>Thank you</h2><p>Your acceptance has been recorded. We will be in touch about the next steps.</p>'; }
        else { err.textContent=(o.j&&o.j.error)||'Something went wrong. Please try again.'; upd(); }
      })
      .catch(function(){ err.textContent='Network problem. Please check your connection and try again.'; upd(); });
  });
})();`;

  setHeaders(res, nonce);
  res.statusCode = 200;
  const title = share.quote_number ? `Quote ${share.quote_number}` : "Your quote";
  res.end(
    shell(
      nonce,
      title,
      `<div class="wrap">${banner}<div class="paper">${share.snapshot_html}</div>${acceptPanel}</div>`,
      script
    )
  );
};
