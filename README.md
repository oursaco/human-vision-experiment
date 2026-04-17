# Classification Test Deployment

This app is now structured for public participant use on a single Node.js server with a persistent SQLite database.

## What changed

- The admin surface is no longer publicly open when `ADMIN_PASSWORD` is set. `/admin.html` and all `/api/experiments` routes now use HTTP Basic auth.
- Participant write operations now require a per-session secret, so a guessed `session_id` is no longer enough to tamper with responses.
- The server no longer exposes the whole project directory as static files. Only `/`, `/admin.html`, and `/data/*` are served.
- Startup now validates that the dataset files exist before the server accepts traffic.
- Production headers, rate limiting, a `/health` endpoint, and a smoke test were added.

## Requirements

- Node.js 18 or newer
- A host with persistent writable disk for `DB_PATH`
- HTTPS at the edge or reverse proxy for real participant traffic

SQLite is appropriate for a single-instance deployment. Do not deploy this on stateless or read-only hosting. If you need multiple app instances, move the database to a networked datastore first.

## Environment

Copy `.env.example` and set at least:

- `NODE_ENV=production`
- `ADMIN_PASSWORD` to a strong random password
- `DB_PATH` to a persistent location outside the release directory
- `TRUST_PROXY=1` if the app sits behind Nginx, Caddy, Cloudflare, Render, Railway, Fly.io, or another proxy

`ADMIN_USERNAME` defaults to `admin`.

## Local run

```bash
npm ci
npm start
```

Participant page: `http://localhost:3000/`

Admin page: `http://localhost:3000/admin.html`

## Smoke check

```bash
npm run smoke
```

This boots the server against a temporary database, creates an experiment, completes one participant session, and verifies the results API.

## Docker

Build:

```bash
docker build -t classification-test .
```

Run:

```bash
docker run \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e ADMIN_PASSWORD=replace-me \
  -e TRUST_PROXY=1 \
  -v classification-data:/data \
  classification-test
```

## Deployment checklist

1. Set `NODE_ENV=production`.
2. Set a strong `ADMIN_PASSWORD`.
3. Mount persistent storage and point `DB_PATH` at it.
4. Put the app behind HTTPS.
5. Set `TRUST_PROXY=1` when behind a reverse proxy.
6. Verify `/health` returns `{"ok":true,...}` after deploy.
7. Log in to `/admin.html`, create a test experiment, and complete a participant run before inviting real users.
