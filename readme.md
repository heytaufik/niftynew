# NIFTY Flow — Order Flow Trading Dashboard
## Production Setup Guide

---

## 🚀 QUICK START (5 minutes)

### Step 1: Get Angel One Credentials

**Login to Angel One SmartAPI:**
https://smartapi.angelbroking.com

**Find 4 things:**

#### 1️⃣ API KEY
```
Dashboard → Settings → API Keys → API Key (copy full key)
```

#### 2️⃣ CLIENT ID
```
Your login ID for Angel One (usually your mobile number or email)
```

#### 3️⃣ PASSWORD
```
Your Angel One account password
```

#### 4️⃣ TOTP SECRET KEY
```
Dashboard → Settings → Security → 2FA → 
"Can't scan QR code?" → Copy Secret Key

⚠️ IMPORTANT: This is a one-time secret — copy it NOW and save it safely
```

**Example format:**
```
API Key:        abc123XYZdef456...
Client ID:      9876543210
Password:       MyPassword@123
TOTP Secret:    JBSWY3DPEBLW64TMMQ======
```

---

### Step 2: Setup Locally (Computer pe)

#### A. Install Node.js
- Download: https://nodejs.org (v18 or higher)
- Install karo
- Terminal/CMD mein check karo:
```bash
node --version
npm --version
```

#### B. Download Project Files

**Option 1: Clone from GitHub (if uploaded)**
```bash
git clone <your-repo-url>
cd nifty-flow
```

**Option 2: Manual Setup**
```bash
# Create folder
mkdir nifty-flow
cd nifty-flow

# Download files (or create manually):
# - server.js
# - package.json
# - railway.json
# - .gitignore
# - public/index.html
```

#### C. Install Dependencies
```bash
npm install
```

This will install:
- `express` — web server
- `dotenv` — environment variables
- `otpauth` — auto TOTP generation
- `axios` — API calls
- `cors` — cross-origin requests

---

### Step 3: Configure .env

**File:** `.env` (root folder mein)

```
ANGEL_API_KEY=YOUR_API_KEY_HERE
ANGEL_CLIENT_ID=YOUR_CLIENT_ID_HERE
ANGEL_PASSWORD=YOUR_PASSWORD_HERE
ANGEL_TOTP_SECRET=YOUR_TOTP_SECRET_HERE
PORT=3000
```

**Example:**
```
ANGEL_API_KEY=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
ANGEL_CLIENT_ID=9876543210
ANGEL_PASSWORD=MySecurePassword@123
ANGEL_TOTP_SECRET=JBSWY3DPEBLW64TMMQ======
PORT=3000
```

⚠️ **NEVER commit .env to GitHub** — already in .gitignore

---

### Step 4: Run Locally

```bash
npm start
```

Expected output:
```
[2026-06-07T09:15:00.000Z] Server started on port 3000
Dashboard: http://localhost:3000
[2026-06-07T09:15:02.345Z] Angel One login successful
```

**Open browser:**
```
http://localhost:3000
```

Click **START ALGO** — live data will load!

---

## 🚀 PRODUCTION DEPLOY (Railway)

### Step 1: Create GitHub Repository

```bash
cd nifty-flow
git init
git add .
git commit -m "Initial commit"
```

Then create new repo on GitHub:
- Go: https://github.com/new
- Name: `nifty-flow`
- Push code:

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nifty-flow.git
git push -u origin main
```

---

### Step 2: Setup on Railway

**Go to:** https://railway.app

#### A. Sign up / Login
- Use GitHub account (easier)

#### B. Create New Project
- Click "New Project"
- Select "Deploy from GitHub"
- Authorize Railway to access GitHub
- Select `nifty-flow` repo

#### C. Add Environment Variables
- Railway console mein:
- Click "Variables" tab
- Add these 4:

```
ANGEL_API_KEY=YOUR_KEY_HERE
ANGEL_CLIENT_ID=YOUR_ID_HERE
ANGEL_PASSWORD=YOUR_PASSWORD_HERE
ANGEL_TOTP_SECRET=YOUR_SECRET_HERE
PORT=3000
```

#### D. Deploy
- Railway automatically detects Node.js
- Click "Deploy"
- Wait 2-3 minutes

#### E. Get Live URL
- Dashboard → Deployments
- Copy domain (example: `nifty-flow-prod.railway.app`)

---

## ✅ VERIFY IT'S WORKING

### Local (3000)
```
http://localhost:3000
```

### Production (Railway)
```
https://nifty-flow-prod.railway.app
```

**Check:**
- ✅ Dashboard loads
- ✅ Click START ALGO
- ✅ NIFTY spot price updates (live from Angel One)
- ✅ Strikes show Bid/Ask data
- ✅ Signals appear (LONG/SHORT/NO TRADE)
- ✅ Demo trades generate

---

## 🔄 AUTO-REFRESH TOKEN

Har 6 hours mein token auto-refresh hota hai. Koi manual work nahi.

---

## ⚠️ SECURITY TIPS

1. **Never share .env file**
2. **TOTP secret safe rakho** — ek baar expose ho gaya toh problem
3. **GitHub pe private repo rakho** (free private repos available)
4. **Password strong rakho** (Angel One account)

---

## 🐛 TROUBLESHOOTING

### Error: "401 Unauthorized"
- Check credentials in .env
- TOTP secret valid hai?
- Angel One login page test karo manually

### Error: "No option tokens found"
- Market closed hai
- Ya expiry mismatch (weekly options check karo)
- Next Thursday ko expiry hona chahiye

### Dashboard loads par API error
- Server ka terminal check karo (error message dekho)
- Network issue? (proxy, firewall check)

### TOTP invalid
- Secret key copy karte time confusion
- Space/padding issues possible
- Recheck `Enable TOTP` in Angel One settings

---

## 📊 WHAT DATA COMES FROM ANGEL ONE

### LIVE (Real-time):
- ✅ NIFTY spot price (NSE token 26000)
- ✅ Option prices (4 contracts: ATM CE/PE, 1 ITM CE/PE)
- ✅ Bid/Ask quantities (order book depth)
- ✅ Volume data
- ✅ Price changes

### NOT PLACED:
- ❌ No real orders placed
- ❌ Paper trading only
- ❌ Demo trades auto-resolved after random time

---

## 🎯 SIGNAL LOGIC (From your PDF)

### LONG Signal:
```
Bid/Ask Ratio > 1.5
AND
Volume Spike (current > average)
AND
Price Flat or Up
```

### SHORT Signal:
```
Bid/Ask Ratio < 0.67
AND
Volume Spike
AND
Price Flat or Down
```

### NO TRADE:
```
Ratio between 0.8-1.2
OR
No volume spike
OR
Direction unclear
```

---

## 📅 MARKET HOURS

Trading sirf **9:15 AM – 3:30 PM IST**

- Demo trades only generate during market hours
- Algo runs 24/7 (scans every 5 sec)
- But trades only when market open

---

## 💰 DEMO TRADING PARAMS

```
Risk per trade:        20 points
Target per trade:      40 points
Risk:Reward ratio:     1:2
Lot size:              50 units
Max open trades:       1 at a time
Demo PnL calc:         (20 pts × 50) = ₹1000 risk
                       (40 pts × 50) = ₹2000 target
```

---

## 📱 RESPONSIVE

- ✅ Desktop optimized
- ✅ Mobile friendly
- ✅ Tablet compatible

---

## 🔗 IMPORTANT LINKS

| | |
|--|--|
| Angel One SmartAPI | https://smartapi.angelbroking.com |
| API Docs | https://smartapi.angelbroking.com/docs |
| Enable TOTP | Angel One App → Settings → Security |
| Railway Docs | https://docs.railway.app |
| GitHub | https://github.com |

---

## 📞 SUPPORT

If stuck:
1. Check error message in server terminal
2. Verify .env values (copy-paste carefully)
3. Test Angel One login manually
4. Check TOTP secret validity

---

## ✨ YOU'RE READY!

```
1. Get credentials from Angel One ✅
2. Create .env file ✅
3. npm install ✅
4. npm start ✅
5. Open http://localhost:3000 ✅
6. Click START ALGO ✅
7. Watch live data stream in! ✅
```

**Production:** Push to GitHub → Railway auto-deploys → Live URL ready!

---

**Happy Trading! 📈**
