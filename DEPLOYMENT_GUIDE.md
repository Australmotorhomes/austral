# Deployment Guide — Austral Motorhomes App

**This guide takes you from GitHub → Netlify in 15 minutes.**

---

## Step 1: Create GitHub Repository

### On GitHub.com:

1. Go to [github.com](https://github.com) and log in
2. Click the **+** icon (top right) → **New repository**
3. **Repository name:** `austral-motorhomes-app`
4. **Description:** "Pricing, quoting, and order management"
5. **Visibility:** Public (so Netlify can access it)
6. Click **Create repository**

---

## Step 2: Prepare Files Locally

### Create a local folder:

```bash
mkdir austral-motorhomes-app
cd austral-motorhomes-app
```

### Copy these files into the folder:

```
austral-motorhomes-app/
├── public/
│   └── index.html              ← I provided this
├── src/
│   ├── index.js                ← I provided this
│   └── App.jsx                 ← Your austral-pricing-app.jsx renamed
├── package.json                ← I provided this
├── .env.example                ← I provided this (DO NOT COMMIT)
├── .gitignore                  ← I provided this
└── README.md                   ← I provided this
```

All these files are in `/mnt/user-data/outputs/`

---

## Step 3: Push to GitHub

### In your local folder:

```bash
git init
git add .
git commit -m "Initial commit - Austral Motorhomes app"
git remote add origin https://github.com/YOUR_USERNAME/austral-motorhomes-app.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

### What Gets Pushed:
✅ `package.json`
✅ `README.md`
✅ `public/index.html`
✅ `src/index.js`
✅ `src/App.jsx`
✅ `.env.example`
✅ `.gitignore`

### What DOESN'T Get Pushed (Git ignores):
❌ `.env.local` (your actual secrets)
❌ `node_modules/` (dependencies)
❌ `.DS_Store` (Mac junk)

---

## Step 4: Connect to Netlify

### On Netlify.com:

1. Go to [netlify.com](https://netlify.com) and log in
2. Click **Add new site** → **Import an existing project**
3. Click **GitHub**
4. Authorize Netlify to access your GitHub account
5. Search for and select: `austral-motorhomes-app`
6. Click **Deploy site**

Netlify will automatically:
- ✅ Build your React app
- ✅ Deploy it live
- ✅ Give you a URL like `https://random-name-12345.netlify.app`

---

## Step 5: Add Environment Variables to Netlify

### Critical - Do This Before the App Works!

1. In Netlify, go to your site
2. Click **Site settings** (top menu)
3. Go to **Build & deploy** → **Environment**
4. Click **Edit variables**
5. Add these two variables:

| Key | Value |
|---|---|
| `REACT_APP_SUPABASE_URL` | `https://dpapwmittcowsrwwsajo.supabase.co` |
| `REACT_APP_SUPABASE_ANON_KEY` | `sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn` |

6. Click **Save**
7. Netlify will **automatically redeploy** your app with these variables

---

## Step 6: Test Your Live App

### Your app is now live at:
```
https://YOUR_SITE_NAME.netlify.app
```

### Test on your devices:

**iPhone:**
1. Open Safari
2. Go to `https://YOUR_SITE_NAME.netlify.app`
3. Tap Share → **Add to Home Screen**
4. App now available as home screen icon

**iPad:**
Same as iPhone

**Windows PC:**
1. Open any browser
2. Go to `https://YOUR_SITE_NAME.netlify.app`
3. Bookmark it

### Verify it works:
1. Create a quote on one device
2. Wait 10 seconds (polling interval)
3. Open the app on another device
4. Your quote should appear ✅

---

## Step 7: Update Your App in the Future

**Whenever you want to update the app:**

1. **Make changes locally** to the code
2. **Test locally** (optional but recommended):
   ```bash
   npm install
   npm start
   ```
3. **Push to GitHub:**
   ```bash
   git add .
   git commit -m "Your changes"
   git push origin main
   ```
4. **Netlify auto-deploys** (usually within 2 minutes)
5. **Check your live site** — changes are live!

**No manual Netlify deployment needed after the first setup.**

---

## Troubleshooting

### "Build failed" error on Netlify

**Check the Netlify build log:**
1. In Netlify, click **Deploys**
2. Click the failed deploy
3. Scroll down to see error messages
4. Common issues:
   - Missing `package.json`
   - Typo in environment variable names
   - Missing files

**Fix locally, test with `npm run build`, then `git push`**

### "App loads but can't save data"

1. Check that environment variables are set in Netlify
2. Verify Supabase project is active
3. Check browser console (F12 → Console) for errors

### "App loads but data doesn't sync"

1. Wait 10 seconds (polling interval)
2. Manually refresh the page
3. Check internet connection
4. Verify both devices are on the same Netlify URL

---

## Example Workflow

```
Day 1: Deploy to Netlify
└─ Follow Steps 1-6 above
└─ App is live on iPhone, iPad, Windows

Day 2: Fix a bug
└─ Edit src/App.jsx locally
└─ Test with npm start
└─ git push
└─ Netlify auto-deploys ✅
└─ Changes live in 2 minutes

Day 3: Add new feature
└─ Add code locally
└─ Test with npm start
└─ git push
└─ Netlify auto-deploys ✅
└─ Available on all devices immediately
```

---

## Git Commands Reference

```bash
# First time setup
git init
git add .
git commit -m "message"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main

# Subsequent updates
git add .
git commit -m "message"
git push

# Check status
git status

# View commits
git log
```

---

## Security Checklist

✅ Environment variables stored in Netlify (not in code)
✅ `.env.local` in `.gitignore` (never committed)
✅ `.env.example` safe to commit (no real keys)
✅ Repository is public (Netlify needs access)
✅ Supabase public key is safe (limited permissions)

---

## You're Done! 🎉

Your Austral Motorhomes app is now:
- ✅ Deployed to Netlify
- ✅ Accessible from iPhone, iPad, Windows
- ✅ Syncing with Supabase database
- ✅ Auto-updating on every `git push`

**Any questions?** Check the main README.md for technical details.
