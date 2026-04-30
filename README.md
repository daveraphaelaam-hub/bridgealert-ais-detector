# BridgeAlert AIS Detector

A Node.js server that runs 24/7, watches live AIS (ship tracking) data, and automatically detects when vessels are passing through 5 Miami drawbridges that FL511 doesn't cover. When an opening is detected, it writes a row to your existing Google Sheet.

## Bridges Monitored

| Bridge | Coordinates |
|--------|-------------|
| Venetian Causeway East | 25.7912, -80.1520 |
| Venetian Causeway West | 25.7899, -80.1815 |
| South Miami Avenue Bridge | 25.7697, -80.1935 |
| NW 17th Avenue Bridge | 25.7855, -80.2230 |
| NW 22nd Avenue Bridge | 25.7887, -80.2314 |

---

## Deployment Guide (Non-Technical)

This guide walks you through getting this running on Render's free tier. You'll need about 30 minutes.

### Step 1: Create a GitHub Account (skip if you already have one)

1. Go to [github.com](https://github.com)
2. Click **Sign up**
3. Follow the prompts — use any email and username you want
4. Verify your email address

### Step 2: Put This Code on GitHub

1. Go to [github.com/new](https://github.com/new)
2. Repository name: `bridgealert-ais-detector`
3. Leave everything else as default, click **Create repository**
4. On the next page, GitHub will show you commands. Don't worry about those — your developer (or Claude Code) will handle pushing the code.

### Step 3: Set Up Google Cloud (for writing to your Google Sheet)

This is the most involved step. Follow carefully.

#### 3a. Create a Google Cloud Project
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your Google account (same one that owns the Google Sheet)
3. At the top, click the project dropdown → **New Project**
4. Name: `bridgealert` → Click **Create**
5. Wait a few seconds, then make sure `bridgealert` is selected in the dropdown

#### 3b. Enable Google Sheets API
1. In the search bar at the top, type `Google Sheets API`
2. Click on it → Click **Enable**

#### 3c. Create a Service Account
1. In the left sidebar, go to **IAM & Admin** → **Service Accounts**
2. Click **+ Create Service Account**
3. Name: `bridgealert-writer`
4. Description: `Writes bridge opening events to Google Sheet`
5. Click **Create and Continue** → **Continue** → **Done**

#### 3d. Download the Key File
1. You'll see `bridgealert-writer@...` in the list — click on it
2. Click the **Keys** tab
3. Click **Add Key** → **Create new key**
4. Choose **JSON** → Click **Create**
5. A file downloads automatically — it has a name like `bridgealert-123abc.json`
6. **Keep this file safe.** You'll need it in Step 5.

#### 3e. Share Your Google Sheet with the Service Account
1. Open the downloaded JSON file with a text editor (TextEdit on Mac, Notepad on Windows)
2. Find the line that says `"client_email"` — copy the email address next to it (looks like `bridgealert-writer@bridgealert-xxxxx.iam.gserviceaccount.com`)
3. Open your BridgeAlert Google Sheet
4. Click **Share** (top right)
5. Paste that email address into the "Add people" field
6. Set permission to **Editor**
7. Click **Send** (or Share)

### Step 4: Create a Render Account

1. Go to [render.com](https://render.com)
2. Click **Get Started for Free**
3. Sign up with GitHub (easiest — click "Sign up with GitHub" and authorize)

### Step 5: Deploy on Render

1. On your Render dashboard, click **New +** → **Web Service**
2. Click **Connect a repository** → Select `bridgealert-ais-detector`
3. Fill in the settings:
   - **Name:** `bridgealert-ais-detector`
   - **Region:** `Oregon (US West)` (or closest to you)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. Scroll down to **Environment Variables** — this is where you add your secrets:

Click **Add Environment Variable** for each of these:

| Key | Value |
|-----|-------|
| `AIS_API_KEY` | `90a094879ff2d83675f48a5e56b10ebde4be5f48` |
| `GOOGLE_SHEET_ID` | Your sheet ID (the part of the URL between `/d/` and `/edit`) |
| `GOOGLE_CREDENTIALS` | The entire contents of the JSON key file you downloaded in Step 3d |

> **How to paste the JSON credentials:** Open the downloaded `.json` file, select all (Cmd+A on Mac), copy, and paste it as the value for `GOOGLE_CREDENTIALS`.

5. Click **Create Web Service**

Render will build and deploy the server. This takes about 2 minutes. You'll see logs appear in real time.

### Step 6: Verify It's Working

1. Once deployed, Render gives you a URL like `https://bridgealert-ais-detector.onrender.com`
2. Add `/health` to the end and open it in your browser
3. You should see JSON that looks like this:
   ```json
   {"ok":true,"uptime":123,"wsState":1,"bridges":[...]}
   ```
4. Check the **Logs** tab in Render — you should see lines like:
   ```
   [AIS] Connected. Sending subscription...
   [AIS] Subscribed. Watching bounding box: [[25.6,-80.4],[25.9,-80.1]]
   ```

If you see those lines, the detector is live and watching the Miami waterways.

---

## Understanding the Logs

| Log line | What it means |
|----------|---------------|
| `[AIS] Connected` | Successfully connected to AISstream.io |
| `[AIS] Disconnected` | Lost connection — auto-reconnect will fire |
| `[Venetian Causeway East] CLOSED → OPENING` | A vessel was detected approaching |
| `[EVENT] ... OPENING → OPEN` | Vessel passed through the bridge span |
| `[sheets] Row written` | Successfully logged to your Google Sheet |
| `[sheets] Write failed, queuing` | Sheet write failed — will retry in 30 seconds |

---

## Tuning the Detection

If you're getting too many false positives (events for boats that didn't actually open the bridge), or missing real openings, edit `config/bridges.json` and re-deploy:

```json
{
  "APPROACH_RADIUS_METERS": 804,       // how far away to start watching a vessel
  "NEAR_BRIDGE_RADIUS_METERS": 100,    // how close = "passed through"
  "MIN_APPROACH_SPEED_KNOTS": 2,       // ignore vessels slower than this
  "HEADING_TOLERANCE_DEGREES": 45,     // how directly toward the bridge (smaller = stricter)
  "POST_PASS_CLOSE_MINUTES": 4         // how long after passage to call it "closed"
}
```

---

## Free Tier Notes (Render)

Render's free tier "spins down" web services after 15 minutes of inactivity. For a 24/7 service like this, **upgrade to the $7/month "Starter" plan** after your initial testing week. The free tier is fine for testing but will miss vessel detections during spin-down periods.

Alternatively, use the free tier and set up an external uptime monitor (e.g., [UptimeRobot](https://uptimerobot.com)) to ping `/health` every 5 minutes to prevent spin-down.
