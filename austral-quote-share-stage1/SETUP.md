# Stage 1 setup — quote links (database + API + public page)

Nothing in App.jsx changes in this stage. Nothing is visible in the app yet.

## 1. Database (Supabase)
Open the Supabase SQL editor for project `dpapwmittcowsrwwsajo`, paste all of `sql/01_quote_shares.sql`, run it.
Expect "Success. No rows returned".

## 2. Secret key (Vercel)
Vercel → your project → Settings → Environment Variables. Add:
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase **secret** key (Supabase → Project Settings → API Keys). Never put this in App.jsx.
- (optional, later) `PUBLIC_BASE_URL` = e.g. `https://austral-rosy.vercel.app`. If you don't set it, links use whatever host the request came in on.
Tick Production (and Preview if you use it).

## 3. Copy files into your project (~/austral)
Copy the `api` folder contents next to your existing `api/tracking-refresh.js`:
```
api/quote-share-create.js
api/quote-view.js
api/quote-accept.js
api/quote-page.js
api/_lib/quoteShare.js
```
## 4. vercel.json
Add the rewrite from `vercel.rewrites.json` to your existing `vercel.json` (merge, don't replace).
If you already have a catch-all rewrite to index.html, the `/q/:token` rule must come BEFORE it.

## 5. Deploy
`cd ~/austral && vercel --prod`

## 6. Quick check (optional, before Stage 2)
Open `https://austral-rosy.vercel.app/q/not-a-real-token-123456789012` — you should see "Quote not found"
(not the Austral app). That proves the rewrite and function are live.

## Local test
`node test/harness.js` — runs the logic checks against an in-memory fake of Supabase.
