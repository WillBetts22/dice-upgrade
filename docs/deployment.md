# Deployment notes

## Requirements of the host

- A **long-running Node 22+ process**. Phase deadlines are checked by a 250 ms ticker in the process, and players hold WebSocket connections open.
- **WebSocket support** on the platform's proxy (path `/ws`). Railway, Render, Fly.io and any VM support this. Serverless platforms such as Vercel functions and Netlify functions do not.
- **Postgres** (any supported version with `jsonb`). The schema is created automatically at startup with `CREATE TABLE IF NOT EXISTS`, so there is no separate migration step.
- **One instance.** See the README limitations. `railway.json` pins `numReplicas: 1`.

## Railway (recommended)

```bash
npm i -g @railway/cli
railway login
railway init --name dice-upgrade
railway add --database postgres
railway add --service web --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up --service web --detach
railway domain --service web
```

Railway builds with `npm ci && npm run build` and starts with `npm start`, as set in `railway.json`. It sets `PORT` automatically. The health check is `GET /healthz`, which returns `{"ok":true,"db":"postgres"}`.

A redeploy restarts the process. Games in progress survive: rooms reload from Postgres and overdue phases finish exactly once. Players' browsers reconnect automatically. Avoid redeploying in the middle of an event anyway, because each player sees a few seconds of "Reconnecting".

## Docker or a VM

```bash
npm ci && npm run build
DATABASE_URL=postgres://user:pass@host:5432/dice PORT=8080 npm start
```

If you terminate TLS in a reverse proxy (nginx or Caddy), forward the `Upgrade` and `Connection` headers for `/ws`.

## Without Postgres

If `DATABASE_URL` is unset, the server uses embedded PGlite at `PGLITE_DIR`. This is fine for a laptop-hosted event on a local network. On Railway, use Postgres instead, because the container filesystem is not persistent unless you attach a volume.
