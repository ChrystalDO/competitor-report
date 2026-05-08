# Competitor Email Intelligence Report

Auto-generated weekly report analysing competitor travel marketing emails from the past 30 days. Deploys to Vercel automatically on every update.

## How it works

1. Every Monday at 6am AEST, a GitHub Action runs
2. It connects to Gmail and pulls all promotional emails from the past 30 days
3. Claude (Anthropic API) analyses the emails and generates insights
4. A fresh `index.html` is committed to this repo
5. Vercel detects the commit and deploys the updated report automatically

---

## One-time setup

### Step 1 — Add GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these four secrets:

| Secret name | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `GMAIL_CLIENT_ID` | Google Cloud Console (see Step 2) |
| `GMAIL_CLIENT_SECRET` | Google Cloud Console (see Step 2) |
| `GMAIL_REFRESH_TOKEN` | Run the auth script (see Step 3) |

---

### Step 2 — Create Gmail API credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "Competitor Report")
3. Go to **APIs & Services → Enable APIs** → enable **Gmail API**
4. Go to **APIs & Services → OAuth consent screen**
   - User type: External
   - Fill in app name (e.g. "Competitor Report"), your email
   - Add scope: `https://www.googleapis.com/auth/gmail.readonly`
   - Add your Gmail address as a test user
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name it anything (e.g. "Competitor Report")
6. Download the credentials JSON — you'll need the `client_id` and `client_secret`

---

### Step 3 — Get your Gmail refresh token

Run this one-time script on your Mac to authorise access and get a refresh token:

```bash
node get-refresh-token.js
```

It will open a browser window asking you to sign in to Gmail and grant read access. Once authorised, it prints your `GMAIL_REFRESH_TOKEN` — copy it into GitHub Secrets.

---

### Step 4 — Connect Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import this GitHub repo
3. Leave all settings as default
4. Hit **Deploy**

From this point, every Monday commit will trigger an automatic Vercel redeploy.

---

## Manual trigger

To run the report immediately without waiting for Monday:

1. Go to your repo on GitHub
2. Click **Actions → Weekly Competitor Report → Run workflow**

---

## Local testing

```bash
# Install dependencies
npm install

# Dry run (no Gmail or Claude API calls)
node generate-report.js --dry-run

# Live run (requires secrets set as environment variables)
ANTHROPIC_API_KEY=xxx GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx GMAIL_REFRESH_TOKEN=xxx node generate-report.js
```
