# Tecumseh Ed Tech Conference — Session Signup

A static signup page (hosted on GitHub Pages) with a Google Sheet as the database, connected by a Google Apps Script web app.

```
Teacher's browser ──► GitHub Pages (index.html, app.js)
                          │  fetch()
                          ▼
                 Apps Script web app (Code.gs)  ──►  Google Sheet
                          │                          ├─ Sessions
                          └─► MailApp confirmation   ├─ Registrations
                                                     └─ Roster (live counts)
```

## What it does

- Teachers enter their name and **district email** (other domains are rejected).
- They browse sessions grouped by time slot and can search by title, presenter or room.
- They sign up with one click. The server enforces the rules:
  - **Seat limit** per session (blank or 0 in Capacity means unlimited).
  - **No overlapping sessions.** Back-to-back sessions are fine.
  - No duplicate signups.
- Re-entering the same email later shows that teacher's schedule and lets them drop sessions.
- A **confirmation email** with the full current schedule goes out after every add or drop.

## Live setup (done)

| Piece | Where |
|---|---|
| Site | https://delbraeth.github.io/tecumseh-edtech/ |
| Google Sheet | "Tecumseh Ed Tech Conference Signups" in patrick.cassidy064@gmail.com's Drive |
| Apps Script project | "EdTech Signup Backend" at script.google.com (standalone; opens the Sheet by ID) |
| Web app URL | in `config.js` → `API_URL` |
| Allowed email domain | `tecumsehlocal.org` |

The Sheet tabs (**Sessions**, **Registrations**, **Roster**) are created automatically on the first request, and re-created if one is deleted.

### Rebuilding from scratch (only if needed)
1. Create a Google Sheet; copy its ID from the URL.
2. At script.google.com create a project, paste `apps-script/Code.gs`, and set `SHEET_ID` and `ALLOWED_DOMAIN` in `CONFIG`.
3. **Deploy → New deployment → Web app**, Execute as **Me**, Who has access **Anyone**. Approve the permission prompt.
4. Put the `/exec` URL in `config.js` → `API_URL` and commit.

If `API_URL` is blank, the page runs in **demo mode** with sample data and saves nothing.

## Managing sessions (in the Sheet)

| Column | Notes |
|---|---|
| SessionID | Unique and stable, e.g. `S01`. **Never change an ID after people sign up**, because registrations point at it. |
| Name, Description, Location, Presenter | Plain text. Edit any time. |
| Start, End | Real date-time cells, e.g. `10/16/2026 8:30 AM`. End is required for the conflict check to work. |
| Capacity | Seat limit. Blank or 0 means unlimited. |
| Active | `FALSE` hides the session and blocks new signups. Existing registrations stay in the sheet. |

Changes show up the next time a teacher loads the page. Nothing needs redeploying.

**Registrations** is an append-only log: a dropped session is marked `Cancelled` rather than deleted, so you have a history. To see who is in a session, filter by SessionID and `Status = Active`. **Roster** shows live counts.

## Changing the code later
After editing the code in the Apps Script editor (keep `apps-script/Code.gs` in this repo in sync), go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. That keeps the same URL. Creating a *new deployment* instead gives you a new URL, and you'd have to update `config.js`.

To freeze signups (for example the day before the event), set `SIGNUPS_OPEN: false` in `Code.gs` and redeploy a new version.

## Known limits (read before going live)
- **Identity is email only.** Anyone who knows a colleague's district address could view or drop that colleague's sessions. The domain restriction stops outsiders, not coworkers. If that matters, the next step is emailing a one-time link or code before changes are allowed.
- **Email quota:** a consumer Gmail account can send about 100 emails a day, and a Google Workspace account about 1,500. Each add or drop sends one email. If the quota runs out, signups still save and the email is skipped. Run the script from a district Workspace account if you expect heavy traffic.
- **Throughput:** a script lock serializes signups so capacity can't be overbooked. That's fine for a few hundred teachers. If everyone clicks at 8:00:00 AM, some may see "server busy, try again."
- Times are displayed in America/New_York.
