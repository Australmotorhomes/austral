# Stage 2 — Send quote to customer (link + Outlook email)

Do these in order (PowerShell paths assume your project is ~/austral).

1. **Supabase SQL editor**: paste and run `sql/02_quotes_order_type.sql` (adds the `order_type` column).
   Do this BEFORE deploying, otherwise the instalment choice won't be saved.
2. Copy files into the project (keep folder names):
   - `App.jsx`                      -> austral/src/App.jsx   (replaces the current one)
   - `api/quote-page.js`            -> austral/api/quote-page.js
   - `api/_lib/quoteShare.js`       -> austral/api/_lib/quoteShare.js
   - `public/terms/QOL_Terms_of_Trade_2026-11.pdf` -> austral/public/terms/ (create the folder)
3. Deploy: `cd ~/austral; vercel --prod`
4. Test on austral-rosy.vercel.app:
   - Open a quote -> choose **Payment instalments** -> Save changes.
   - Click **Send to customer** -> check name/email prefilled -> **Create link**.
   - **Copy email for Outlook**, paste into a new Outlook message.
   - **Preview as customer** (not counted as a view). Open the plain link in a private window to test a real view.
   - Download PDF: confirm 14 days, instalments, and the Terms of Trade link work.

Notes
- Terms PDF should be reviewed by a solicitor (forfeiture + balance payable clause) before customers rely on it.
- Stage 3 (view/acceptance notifications) and Stage 4 (Sent quotes summary) come next.
