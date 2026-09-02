# Matchday backend

A real Node.js server for the Matchday app: fetches soccer stats/standings/injuries
from API-Sports on a schedule, caches them in a local SQLite database, and generates
AI match analysis and news summaries on demand via the Claude API — only when someone
actually clicks the button, never automatically.

## What's actually working right now

- ✅ Server boots cleanly, no crashes
- ✅ Database creates itself automatically on first run, using Node's built-in
  `node:sqlite` module — no native compilation, no node-gyp, nothing that can fail
  to build depending on which Node version a host happens to run
- ✅ The insert/upsert/transaction logic is tested with real data (not just the
  empty-database path) — confirmed a fresh insert and a conflict-resolution update
  both work correctly
- ✅ Every route returns an honest "not loaded" response when a key is missing,
  instead of crashing or faking data
- ✅ `/api/health` confirms which keys are actually set
- ⚠️ **Not yet verified**: the actual API-Sports calls, since I don't have a key to
  test against their live API. The endpoint shapes for `/standings` and `/injuries`
  are confirmed against API-Sports' real documentation; `/fixtures/headtohead` and
  `/fixtures/lineups` are not yet double-checked the same way.
- ⚠️ **Not yet wired up**: `public/desktop.html` and `public/mobile.html` are the same
  static prototype files from before — they still show the hardcoded Villa vs Arsenal
  example, not live data from this backend. That's the next step once the API-Sports
  integration is confirmed working.

## First deploy failed — here's what happened and what changed

The first version used `better-sqlite3`, a popular but native (C++) SQLite package.
Render's free tier runs a very new Node version, and that package's prebuilt binaries
didn't cover it yet — it tried to compile from source and failed on outdated V8 API
calls. This isn't something in your setup that was wrong; it's a common type of
problem with native Node modules on fast-moving hosting platforms.

Fixed by switching to `node:sqlite`, which ships inside Node itself — no separate
package, no compilation step, nothing that can fail this way again regardless of
which Node version a host runs in the future.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy the environment template and fill in your real keys:
   ```
   cp .env.example .env
   ```
   Then open `.env` and paste in `ANTHROPIC_API_KEY` (from console.anthropic.com)
   and `API_SPORTS_KEY` (from dashboard.api-sports.io).
3. Run it locally:
   ```
   npm start
   ```
   Visit http://localhost:3000 — you should see the frontend, and
   http://localhost:3000/api/health should show `hasApiSportsKey: true` once your
   key is in place.

## Project structure

```
src/
  server.js              — the Express app, ties everything together
  db.js                  — SQLite schema and connection
  services/
    apiSports.js          — calls API-Sports, returns clean JS objects (or null on failure)
    claude.js              — calls the Claude API for AI analysis and news search
    scheduler.js           — refreshes cached data every REFRESH_INTERVAL_MINUTES
  routes/
    standings.js           — GET /api/standings
    games.js                — GET /api/games, GET /api/games/:fixtureId
    ai.js                   — POST /api/ai/:fixtureId
    news.js                 — POST /api/news/:fixtureId
public/                  — the frontend (served as static files)
data/                    — the SQLite database file (created automatically, gitignored)
```

## Deploying to Render

1. Push this folder to a new GitHub repository.
2. In Render: New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add `ANTHROPIC_API_KEY` and `API_SPORTS_KEY` as environment
   variables — same names as in `.env.example`. This is the secure way to add
   them; they never go in the code itself.
5. Deploy. Render assigns the `PORT` variable automatically — the server already
   reads it, no changes needed.

One thing to know: on Render's free tier, the server "sleeps" after 15 minutes with
no visits, and takes 30-50 seconds to wake up on the next request. Fine while testing;
worth the $7/month Starter plan once this is something you're checking regularly.

## Notes on cost control

- API-Sports and standings refresh on a timer (`REFRESH_INTERVAL_MINUTES` in `.env`,
  defaults to 30) — not on every visit.
- The Claude API is **only** called when `/api/ai/:id` or `/api/news/:id` is hit, i.e.
  when someone clicks the button in the app. Results are cached in `ai_cache`, so
  reopening the same match doesn't trigger another API call unless you pass
  `?force=true`.
