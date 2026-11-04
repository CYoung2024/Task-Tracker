# task-tracker

A personal task tracker for LAN use.

- **Daily**: a checklist that resets every day. Each routine is set to show up every day
  (e.g. *Read my Bible*) or on certain weekdays only (e.g. *Clean the house* on Saturdays).
  You can step back to earlier days, and a streak counter shows how many scheduled days in a row you've done it.
- **Longer-out routines**: every so many days, weeks, months or years, counted from the routine's start date
  (every 3 months starting Jan 1 gives Jan 1, Apr 1, Jul 1, Oct 1). Every routine has a start date,
  today by default, and the Routines tab lists them all together, soonest first.
  Unlike weekly routines, a missed one stays on your daily list, marked with its due date, until you check it off or
  the next one comes around. Its ping can go out days ahead of the date instead of on the day, and neither ping repeats
  while it waits. If the day doesn't exist in a shorter month, it lands on that month's last day.
- **To-do**: a regular to-do list that stays put from day to day until you check things off. Items with a due date come first, soonest on top. Below them, new items land at the top of the undated ones, and you can drag the handle on the left of an undated item to reorder.
  Items can have a due time and/or a reminder time.
- **Reminders**: messages posted to a Discord channel by a webhook:
  - *"Time for: Read my Bible"* at a routine's **Ping me at** time (e.g. 6:00 AM)
  - *"Overdue: …"* when a routine passes its **Overdue after** time and isn't checked off
  - at a to-do's **Remind me** time, and again when it passes its **Due** time

Stack: Node 22 + Express, SQLite (Node's built-in `node:sqlite`, so there are no native modules to build),
plain HTML/CSS/JS front end with no build step, and a Discord webhook for notifications.

## Run it locally

```bash
npm install
npm run dev
npm test
```

Everything (tasks, history, settings including the webhook URL) is in `./data/tasks.db`, so **back up `data/`**.

## Configuration

Set these as environment variables (see `.env.example`):

| Variable              | Default  | Notes                                                                        |
| --------------------- | -------- | ---------------------------------------------------------------------------- |
| `PORT`                | `3000`   |                                                                              |
| `DATA_DIR`            | `./data` | Where the SQLite database lives                                              |
| `DISCORD_WEBHOOK_URL` | *(none)* | Optional. You can paste it on the **Reminders** tab instead; that one wins.  |
| `DISCORD_USER_ID`     | *(none)* | Optional. Your user ID, so each reminder @mentions you. Also settable in the app. |
| `APP_URL`             | *(none)* | Optional, e.g. `https://personal.charlestackyoung.com`. Adds a link back to the app at the end of each reminder. |

Routine times are read in the time zone set on the **Reminders** tab. It's taken from your browser
the first time you open the app.

## Hosting it at home

There's no login, so **don't expose port 3000 (or the proxy in front of it) to the internet**.
Keep it reachable only from your LAN / WireGuard / Tailscale.

```bash
cp .env.example .env              # optional: webhook URL, user ID, APP_URL
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build      # listens on 127.0.0.1:3000
```

or without Docker: `npm ci --omit=dev && npm start` (Node 22.13+).

HTTPS is optional. Notifications go through Discord, so plain `http://` on your LAN works fine.
If you want HTTPS anyway, the name resolves to a private IP, so use a **DNS challenge** for the
certificate (e.g. Caddy with your DNS provider's plugin), or `tailscale serve --bg 3000` if you only
reach it over Tailscale.

The server needs **outbound** internet access to `discord.com` to post reminders. Your phone gets
them through the Discord app wherever you are; opening the tracker itself still needs the VPN.

Run a **single instance**: the reminder scheduler runs inside the server process, every 30 seconds.

## Setting up Discord reminders

1. In Discord, create a server (just you) and a channel for reminders, e.g. `#tasks`.
2. **Server Settings → Integrations → Webhooks → New Webhook**, choose the channel, then **Copy Webhook URL**.
3. In the tracker, open **Reminders**, paste the URL and **Save**, then **Send a test ping**.
4. Make sure your phone actually buzzes, using either of these:
   - set the channel's notifications to **All Messages** (long-press the channel → Notification Settings), or
   - fill in **Mention me** with your Discord user ID (turn on *Settings → Advanced → Developer Mode*,
     then long-press your name → *Copy User ID*). Each reminder then @mentions you, which notifies
     even with the default *Only @mentions* setting.

Each reminder starts with 🔔, or ⚠️ when something is overdue, followed by what it's for, so your
lock screen shows it. If Discord can't be reached, the server retries every 30 seconds until 30 minutes
after the reminder was due.

If the server was down when a reminder was due, it still sends it once it comes back, as long as
that's within 30 minutes. Older reminders are skipped so you don't get a burst of stale pings.

## Layout

```
server/
  index.js       entry point: opens DB, starts scheduler + HTTP server
  app.js         Express routes (/api/today, /api/routines, /api/todos, /api/settings, /api/notify/test)
  reminders.js   pure "which reminders are due right now" logic
  scheduler.js   30s loop: due reminders -> dedupe -> Discord
  discord.js     webhook message format + sending
  db.js, time.js
public/          the front end (index.html, app.js, styles.css)
  schedule.js    pure "when does this routine come around" logic, also used by the server
test/            node:test suites
```
