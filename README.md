# LIGIBET

Crash (Aviator-style) gaming platform: an Angular 21 single-page frontend and a
Node/Express + Socket.IO backend backed by MongoDB, with M-Pesa deposits and
withdrawals through PayHero.

```
backend/    Express API, Socket.IO game engine, Mongoose models
frontend/   Angular application
scripts/    Build-time configuration checks
```

## Running locally

Node 20.19+, 22.12+ or 24+ is required (Angular 21's floor).

```bash
cp backend/.env.example backend/.env   # then fill in the values
npm --prefix backend install
npm --prefix frontend install

npm run dev:backend    # API on http://localhost:3000
npm run dev:frontend   # UI  on http://localhost:4200
```

A frontend served from `localhost`, `127.0.0.1` or a private LAN address talks
to `http://<same-host>:3000` automatically, so a local UI can never end up
driving the deployed game engine by accident.

## Configuration

Every value lives in the environment; see `backend/.env.example` for the full
list and the reasoning behind each one. `backend/.env` is git-ignored and must
stay that way — it holds the database credentials and the JWT signing key.

Three variables have no safe default and the server refuses to start without
them:

| Variable | Notes |
| --- | --- |
| `JWT_SECRET` | At least 32 random characters. There is deliberately no fallback: a committed default would let anyone mint a superadmin token and approve their own withdrawals. |
| `MONGODB_URI` | Must name the database explicitly before the `?`. A URI without one resolves to the driver's default, which is how this deployment once served an empty database while every real account sat untouched on another cluster. |
| `CORS_ORIGIN` | Comma-separated browser origins. One wildcard label is allowed per entry, e.g. `https://*.vercel.app`, which is how preview deployments reach the API without being listed individually. |

`npm run check` runs the same configuration checks the build runs. It fails on
the deployment mistakes that have taken this site down before — a BOM in
`vercel.json`, a cached app shell, a connection string hardcoded in source —
each of which breaks silently hours after the deploy that caused it.

## Deployment

The site is **ligibet.site**. It runs in two places from the same commit: Render
hosts the API and the realtime game engine at `api.ligibet.site`, and Vercel
serves the frontend from its CDN at `ligibet.site`, pointed at that API.

| Host | Record | Points at |
| --- | --- | --- |
| `ligibet.site` | A / ALIAS | Vercel (values come from the Vercel domain screen) |
| `www.ligibet.site` | CNAME | `cname.vercel-dns.com` |
| `api.ligibet.site` | CNAME | `<your-service>.onrender.com` |

Both providers issue TLS certificates automatically once the records resolve,
which usually takes minutes but can take longer to propagate.

The frontend is a static bundle, so the API origin has to be chosen at build
time rather than read at runtime. `BACKEND_ORIGIN` does that:
`frontend/scripts/write-backend-origin.js` writes it into the generated config
the app imports before `ng build` runs. With the variable unset the committed
default (`https://api.ligibet.site`) is used unchanged.

### Render — API and game engine

`render.yaml` is a blueprint: create the service with **New → Blueprint** and
point it at this repository, and the build command, start command, health check
and environment variable list come from that file. The variables marked
`sync: false` are the secrets, and Render prompts for them on first deploy.

Health checks hit `/healthz`, which reports 503 while the configuration is
invalid or the database is unreachable — so a broken build is rolled back
instead of replacing a working one. It also reports which cluster and database
the process actually connected to, and how many accounts it can see.

The build compiles the frontend too, and `server.js` serves it when
`frontend/dist/frontend/browser` exists. The Render URL is therefore a complete,
standalone copy of the site, not just an API.

**This service must stay on a single instance.** Rounds, their timers and the
connected sockets all live in process memory. A second instance would run its
own round with its own multiplier, and two players would see different results
for the same bet.

Note that Render's free plan idles a service after inactivity and takes
roughly a minute to wake it. For a crash game that is a cold start in the
middle of a round, so the paid plan is the one to use for real traffic.

### Vercel — frontend

Import the repository with the root directory left at the repository root;
`vercel.json` supplies the build command, the output directory
(`frontend/dist/frontend/browser`) and the SPA rewrite. Then set one environment
variable:

```
BACKEND_ORIGIN = https://<your-render-service>.onrender.com
```

Once `api.ligibet.site` is attached to the Render service, `BACKEND_ORIGIN` can
be dropped — the committed default already points there.

Finally add every frontend origin to `CORS_ORIGIN` on Render, otherwise the
browser blocks every API call. That failure looks like the site hanging rather
than an error, so it is worth checking first when a fresh deployment does
nothing.

The cache rules matter and `npm run check` enforces them: hashed assets are
immutable for a year, while `/` and `/index.html` are `no-store`. A cached app
shell keeps asking for chunk files that the next deploy deleted, and the app
simply fails to boot.

### First boot on a fresh database

A new cluster is empty, and an empty database is the one failure this codebase
cannot detect on its own: every login fails and every registration disappears,
while the API itself looks healthy. The server therefore refuses to start until
you say the emptiness is intentional.

1. Set `ALLOW_EMPTY_DATABASE=true` on Render for the first deploy.
2. Create the first administrator — the account that can approve withdrawals, so
   give it a real passphrase:

   ```bash
   MONGODB_URI='<the same URI Render uses>' \
     node backend/create-superadmin.js admin 254712345678 '<a long passphrase>'
   ```

   There are no default credentials: the script requires all three arguments and
   refuses to run without `MONGODB_URI`.
3. Remove `ALLOW_EMPTY_DATABASE` once real accounts exist, so the guard is back
   in place the next time the connection string is wrong.

Confirm what the running service actually connected to before opening it up —
`/healthz` reports the cluster host, the database name and the account count:

```bash
curl https://api.ligibet.site/healthz
```
