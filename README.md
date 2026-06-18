# ⚽ WC2026 Predictions Platform

Private FIFA World Cup 2026 prediction competition for friends.

## Default Admin Login

| Username | Password |
|----------|----------|
| `admin`  | `admin123` |

**Change the admin password immediately after first login!**

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and set a session secret
cp .env.example .env
# Edit .env: set SESSION_SECRET to any long random string

# 3. Start the server
npm start
# → Opens at http://localhost:3000
```

The SQLite database is created automatically at `db/wc2026.db` on first run, with 104 seeded matches and 5 award categories.

---

## Deploy to Railway (Recommended — Free Tier)

1. Push this folder to a GitHub repo (public or private)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. In the Railway project settings → **Variables**, add:
   ```
   SESSION_SECRET = <any long random string, e.g. run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   NODE_ENV = production
   PORT = 3000
   ```
5. Railway auto-detects Node.js and runs `npm start`
6. Your site is live at the Railway-provided URL

**Important for Railway:** SQLite writes to the filesystem. Railway's filesystem is **ephemeral** (resets on redeploy). For persistence, either:
- Add a Railway volume mount at `/app/db`
- Or switch to a hosted PostgreSQL (Railway provides one free)

For a simple friend group, adding a volume is easiest:
- In Railway → your service → Settings → Add Volume → Mount path: `/app/db`

---

## Deploy to Render (Free Tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables: `SESSION_SECRET`, `NODE_ENV=production`
6. Add a **Disk** (under Advanced): Mount path `/app/db`, size 1 GB
7. Deploy

---

## Deploy to Fly.io

```bash
# Install flyctl, then:
fly launch          # follow prompts
fly volumes create wc2026_db --size 1
# In fly.toml, mount the volume at /app/db
fly secrets set SESSION_SECRET=<your-secret>
fly deploy
```

---

## First-Time Admin Setup Checklist

After deploying:

1. **Log in** as `admin` / `admin123`
2. **Change admin password** (navbar → Password)
3. Go to **Admin → Users** → Add all your friends as users
4. Go to **Admin → Awards** → Add player name options to each award category
5. Go to **Admin → Matches** → Update team names in knockout rounds as they are confirmed (placeholder names like "R32 Winner 1" are pre-seeded)
6. **Lock award predictions** before the tournament starts (Admin → Awards → Lock each category)
7. As each round begins, **lock matches** for that round (Admin Dashboard → Quick Lock by Round)
8. After each match is played, **enter the result** (Admin → Results)

---

## Scoring Summary

| Stage | Points | Bonus |
|-------|--------|-------|
| Group Stage | 1 pt correct prediction | — |
| Round of 32 | 2 pts correct winner | +1 correct AET |
| Round of 16 | 3 pts | +1 |
| Quarterfinals | 4 pts | +1 |
| Semifinals | 5 pts | +1 |
| 3rd Place | 4 pts | +1 |
| **Final** | **6 pts** | +1 |
| Each Award | 10 pts | — |

AET bonus is only awarded when the user correctly predicted the winner AND the AET outcome.

---

## Project Structure

```
wc2026/
├── server.js          # Express app entry point
├── db/
│   └── database.js    # SQLite schema, seed data, scoring engine
├── routes/
│   ├── auth.js        # Login / logout / change-password
│   ├── user.js        # Dashboard, matches, predictions
│   ├── leaderboard.js # Leaderboard with filters
│   ├── awards.js      # Tournament award predictions
│   └── admin.js       # Full admin panel
├── middleware/
│   └── auth.js        # requireLogin / requireAdmin guards
├── views/
│   ├── partials/      # header.ejs, footer.ejs, admin-nav.ejs
│   ├── admin/         # All admin pages
│   ├── login.ejs, dashboard.ejs, matches.ejs, leaderboard.ejs, awards.ejs, rules.ejs
│   └── ...
└── public/
    ├── css/style.css  # Full design system (dark theme)
    └── js/main.js     # Minimal frontend JS
```

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** SQLite (via better-sqlite3)
- **Auth:** express-session + bcryptjs
- **Views:** EJS templates
- **Styling:** Custom CSS (no frameworks — lightweight)

---

## Timezone

All match times are stored in **UTC** in the database and displayed in **Kuwait Time (UTC+3 / Asia/Kuwait)** in the UI. The server uses the Node.js `Intl` API — no extra timezone library required.
