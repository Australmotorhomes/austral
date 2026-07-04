# Austral Motorhomes — Supabase REST API Setup Guide

This guide walks you through using the Austral Motorhomes app with **Supabase REST API + Polling** for automatic sync across iPhone, Windows PC, and iPad.

## Overview

Your app now uses **Supabase REST API** (instead of the JavaScript SDK) with **polling every 10 seconds** to check for data changes:

- ✅ Real-time sync across devices (every 10 seconds)
- ✅ Works in Claude.ai artifacts (no SDK needed)
- ✅ Simple, reliable, uses standard HTTP requests
- ✅ No need for external storage services
- ✅ Free tier supports your use case
- ✅ Works on any device with a web browser

## How It Works

```
Device 1 (Windows PC)
└─ Makes a change (create quote)
   └─ Polls Supabase every 10 seconds
      └─ Device 2 (iPhone) sees the change after next poll
```

**Polling Cycle (every 10 seconds):**
1. App requests fresh data from Supabase via REST API
2. Compares with local cache
3. If changed, updates local state
4. User sees the change

## What's Already Done

- ✅ React app rewritten to use Supabase REST API
- ✅ Polling mechanism implemented (10-second interval)
- ✅ 10 tables already created in Supabase
- ✅ Supabase credentials already in the app code
- ✅ localStorage caching for offline support

## What You Need to Do

### Step 1: Verify Your Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Log in with your account
3. Click project: `dpapwmittcowsrwwsajo`
4. Verify all 10 tables exist (in "Tables" section)

### Step 2: Open the React App

The app is already running:

1. **In Claude.ai (this chat):**
   - The artifact is ready to use
   - Click to open it
   - Data auto-polls from Supabase every 10 seconds

2. **Or deploy to a web server:**
   - Push the React app to GitHub
   - Deploy via Netlify
   - Get a live URL for all devices

### Step 3: Test Multi-Device Sync

**On Device 1 (Windows PC):**
1. Open the app
2. Create a new quote
3. Wait 10 seconds (polling interval)

**On Device 2 (iPhone):**
1. Open the same app
2. **You should see the new quote appear** (automatically after polling)
3. Create a new customer
4. Wait 10 seconds

**Back on Device 1:**
1. **You should see the new customer** (after polling)

✅ **Multi-device sync is working!**

## REST API Architecture

The app uses verified REST API syntax:

```javascript
// GET (Read data)
GET /rest/v1/quotes?select=*

// POST (Create data)
POST /rest/v1/quotes
{ "party": "John Smith", "model": "Scout", ... }

// PATCH (Update data)
PATCH /rest/v1/quotes?id=eq.123
{ "status": "Accepted" }

// DELETE (Delete data)
DELETE /rest/v1/quotes?id=eq.123
```

All requests include:
```
Authorization: Bearer sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn
Content-Type: application/json
```

## Polling Interval

The app polls Supabase **every 10 seconds** for updates.

**This means:**
- ✅ Changes appear on other devices within ~10 seconds
- ✅ Lightweight, doesn't overload the server
- ✅ Minimal bandwidth usage
- ⚠️ Not instant like true real-time, but close enough

## Supabase Credentials (Already in App)

Your app already has these embedded:

```
Project URL: https://dpapwmittcowsrwwsajo.supabase.co
Public Key: sb_publishable_0m-oMR8pDlxdij36m4Fj9w_yAVcVIVn
```

## Database Schema (10 Tables)

All tables exist with proper columns:

### 1. items, 2. quotes, 3. quote_items, 4. purchase_orders, 5. po_items
### 6. payment_milestones, 7. customers, 8. suppliers, 9. crm_prospects, 10. categories
### 11. sequences (for auto-incrementing quote/PO numbers)

See the `SUPABASE_SETUP.sql` file for complete schema.

## How Sync Works

1. **App starts** → Polling loads fresh data from Supabase
2. **User creates quote on Device 1** → Stored locally + synced to Supabase
3. **Polling on Device 2 triggers** (every 10 seconds) → Fetches latest data
4. **Quote appears on Device 2** → User sees it

## Offline Support

- ✅ App caches data in localStorage
- ✅ Works offline using cached data
- ✅ When back online, polling syncs with Supabase
- ✅ No data loss

## Troubleshooting

### "Changes not appearing after 10 seconds"
1. Refresh the page manually
2. Check browser console (F12 → Console) for errors
3. Verify internet connection
4. Check Supabase project status

### "Data appears inconsistent between devices"
1. Wait for the next polling cycle (10 seconds)
2. Refresh the page
3. Check if your changes actually saved to Supabase

### "Can't access Supabase dashboard"
1. Go to [supabase.com](https://supabase.com)
2. Log in with your account
3. Project should be visible

## Deployment

### To Use on iPhone/iPad/Windows:

1. **Claude.ai (this chat):**
   - Open the artifact
   - Works on all devices

2. **GitHub + Netlify (recommended for production):**
   - Push app to GitHub
   - Deploy to Netlify
   - Get live URL
   - iPhone: Safari → Share → "Add to Home Screen"
   - Windows: Bookmark or visit URL
   - iPad: Same as iPhone

## Limitations & Future Improvements

**Current (REST API + Polling):**
- ✅ Simple, reliable, works everywhere
- ⚠️ 10-second delay for inter-device sync
- ⚠️ Not as efficient as true real-time (more API calls)

**If you needed instant sync in the future:**
- Would require WebSocket implementation
- Requires backend SDK support
- More complex to maintain

For your use case (3 devices, small team), polling every 10 seconds is perfectly adequate.

## Support

**If something breaks:**
1. Check the Supabase dashboard for any project issues
2. Run the SUPABASE_SETUP.sql again to reset tables
3. Check browser console for errors
4. Verify all 10 tables exist in Supabase

---

**You're all set!** Your app now syncs across devices via Supabase REST API with 10-second polling. Changes appear automatically on other devices without requiring manual refresh.

