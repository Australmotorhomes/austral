# Austral Motorhomes — Pricing, Quoting & Order Management

A modern web application for managing quotes, purchase orders, customers, suppliers, and pricing with real-time multi-device sync via Supabase.

**Live on:** iPhone, iPad, Windows PC via Netlify + Supabase

---

## Quick Start (5 Minutes)

### Prerequisites
- GitHub account (you have this ✅)
- Netlify account (you have this ✅)
- Supabase project already created (you have this ✅)

### Deploy to Netlify

1. **Clone or create repository on GitHub**
   ```bash
   git clone https://github.com/YOUR_USERNAME/austral-motorhomes-app.git
   cd austral-motorhomes-app
   ```

2. **Add these files to the repo:**
   - `package.json`
   - `.env.example`
   - `.gitignore`
   - `public/index.html`
   - `src/index.js`
   - `src/App.jsx` (the main app file)

3. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Initial commit - Austral Motorhomes app"
   git push origin main
   ```

4. **Deploy to Netlify**
   - Go to [netlify.com](https://netlify.com)
   - Click **"New site from Git"**
   - Connect your GitHub repository
   - Click **"Deploy site"**
   - Netlify will build and deploy automatically

5. **Add Environment Variables to Netlify**
   - In Netlify, go to **Site settings** → **Build & deploy** → **Environment**
   - Click **"Edit variables"**
   - Add these two variables:
     ```
     REACT_APP_SUPABASE_URL = https://dpapwmittcowsrwwsajo.supabase.co
     REACT_APP_SUPABASE_ANON_KEY = sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn
     ```
   - Netlify will redeploy automatically

6. **Test Your App**
   - Your app is now live at: `https://YOUR_SITE_NAME.netlify.app`
   - Open on iPhone, iPad, and Windows
   - All devices sync via Supabase in real-time

---

## File Structure

```
austral-motorhomes-app/
├── public/
│   └── index.html              # HTML entry point
├── src/
│   ├── index.js                # React DOM render
│   └── App.jsx                 # Main application (austral-pricing-app.jsx)
├── package.json                # Dependencies
├── .env.example                # Environment variable template
├── .gitignore                  # Git ignore rules
└── README.md                   # This file
```

---

## Architecture

```
GitHub Repository
    ↓
Netlify (Auto-deploys on git push)
    ↓
Frontend (Your React App)
    ↓
Supabase REST API
    ↓
PostgreSQL Database + Real-time Sync
```

**Flow:**
1. You push code to GitHub
2. Netlify detects the change
3. Netlify builds your React app
4. Your app loads in browser
5. App connects to Supabase via REST API
6. Changes sync across devices in real-time (10-second polling)

---

## Local Development

### Run Locally Before Deploying

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create `.env.local` file**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and add your Supabase credentials (already filled in from `.env.example`)

3. **Start development server**
   ```bash
   npm start
   ```
   Opens http://localhost:3000 automatically

4. **Test the app**
   - Create quotes, customers, etc.
   - Verify data saves to Supabase
   - Open on multiple devices to test sync

5. **Build for production**
   ```bash
   npm run build
   ```
   Creates `/build` folder with optimized files

---

## How It Works

### Data Flow

1. **User creates a quote** → App calls Supabase REST API (POST)
2. **Supabase saves to database** → Immediately persisted
3. **Other devices poll every 10 seconds** → Fetch latest data
4. **Quote appears on all devices** → Without manual refresh

### Real-Time Sync (10-Second Polling)

- Every 10 seconds, the app checks Supabase for new data
- If changes detected, local state updates
- UI refreshes automatically
- No need for manual refresh on other devices

### Database Tables

All 10 tables automatically created in Supabase:
- `items` — Price book
- `quotes` — Customer quotes
- `quote_items` — Quote line items
- `purchase_orders` — PO tracking
- `po_items` — PO line items
- `payment_milestones` — Payment schedule
- `customers` — Customer database
- `suppliers` — Supplier database
- `crm_prospects` — Sales pipeline
- `categories` — Item categories
- `sequences` — Auto-increment counters

---

## Deploying Updates

Once deployed to Netlify, deployment is **automatic**:

1. **Make code changes** on your local machine
2. **Test locally** (`npm start`)
3. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Your changes"
   git push origin main
   ```
4. **Netlify auto-deploys** (usually within 1-2 minutes)
5. **Check your live site** at `https://YOUR_SITE_NAME.netlify.app`

No manual deployment needed after the first setup.

---

## Environment Variables

### What Are They?

Environment variables store sensitive information (like API keys) separate from your code.

### Why Not Hard-Code Keys?

- ❌ Hard-coding keys = exposing them on GitHub = security risk
- ✅ Environment variables = keys stay secret, only loaded at runtime

### Where They Go

**Local Development (`.env.local`):**
```
REACT_APP_SUPABASE_URL=https://...
REACT_APP_SUPABASE_ANON_KEY=sb_...
```

**Production (Netlify Settings):**
Same variables added in Netlify Site Settings → Environment

### In Your React App

```javascript
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY;
```

---

## Troubleshooting

### "Build failed on Netlify"

1. Check Netlify build logs (Site settings → Build & deploy → Deploy log)
2. Common causes:
   - Missing `package.json`
   - Missing environment variables
   - Typo in `.env` variable names
3. Fix locally, test with `npm run build`, then push to GitHub

### "App loads but can't save data"

1. Check browser console (F12 → Console)
2. Verify environment variables are set in Netlify
3. Check Supabase project status dashboard
4. Verify network connectivity

### "Data not syncing between devices"

1. Wait 10 seconds (polling interval)
2. Manually refresh the page
3. Check if both devices are on the same Netlify URL
4. Verify internet connection on both devices

### "Cannot find module..."

1. Run `npm install` to install dependencies
2. Clear npm cache: `npm cache clean --force`
3. Delete `node_modules` folder and run `npm install` again

---

## Security Best Practices

✅ **Do:**
- Keep `.env.local` in `.gitignore` (never commit)
- Use environment variables for all sensitive keys
- Keep `.env.example` as a template (safe to commit)
- Use Supabase public anon key (read/write limited by RLS)

❌ **Don't:**
- Hard-code API keys in source files
- Commit `.env.local` to GitHub
- Share your `.env.local` file
- Use production keys during development

---

## Multi-Device Setup

### iPhone/iPad
1. Open Safari
2. Visit `https://YOUR_SITE_NAME.netlify.app`
3. Tap Share → "Add to Home Screen"
4. App now available as home screen icon

### Windows PC
1. Open any browser (Chrome, Edge, Firefox)
2. Visit `https://YOUR_SITE_NAME.netlify.app`
3. Bookmark it (Ctrl+D)

### All Devices
- Same URL across all devices
- All data syncs via Supabase
- Changes visible within 10 seconds

---

## Next Steps

1. **Follow the "Quick Start" section above** to deploy
2. **Test on all your devices** (iPhone, iPad, Windows)
3. **Create some test data** and verify it syncs
4. **Check Supabase dashboard** to see data persisted in database

---

## Support

**If something doesn't work:**

1. Check Netlify build logs
2. Check browser console (F12 → Console)
3. Verify environment variables are set
4. Verify GitHub repo is public or Netlify has access
5. Verify Supabase project is active

---

## Technical Stack

- **Frontend:** React 18
- **Backend/Database:** Supabase (PostgreSQL)
- **Hosting:** Netlify
- **Version Control:** GitHub
- **API:** Supabase REST API
- **Real-time:** 10-second polling

---

## Version History

- **v1.0.0** — Initial release with REST API + polling sync

---

**Built for Austral Motorhomes**
Multi-device pricing, quoting, and order management system.
