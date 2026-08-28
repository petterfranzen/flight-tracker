# Deploying to the UGREEN NAS

Images are built once in CI and pulled by the NAS — nothing gets built on
the NAS itself.

## 1. Publish the images

Push to `main` (or run the workflow manually from the Actions tab). This
builds `backend` and `frontend` for both amd64 and arm64 and pushes them to
GHCR as `ghcr.io/petterfranzen/flight-tracker-{backend,frontend}:latest`.

## 2. Make the GHCR packages pullable from the NAS

GHCR packages are private by default. Pick one, on github.com (not
something I can do on your behalf):

- **Make them public** — on each package's page (github.com/users/petterfranzen/packages),
  Package settings → Change visibility → Public. Simplest if you're fine
  with the images being public (the source already is).
- **Keep them private** — on the NAS, `docker login ghcr.io` with a GitHub
  Personal Access Token that has `read:packages` scope. Create the token
  yourself at github.com/settings/tokens; don't paste it to me.

## 3. Get the compose files onto the NAS

Copy `deploy/docker-compose.yml` and a filled-in copy of `deploy/.env.example`
(as `.env`, same directory) onto the NAS — e.g. via UGOS's File Manager, or
`scp deploy/docker-compose.yml deploy/.env <nas-user>@<nas-host>:~/flight-tracker/`.

## 4. Run it

Either through UGOS's Docker app (Container Manager-style UI: create a new
Compose project, point it at the uploaded `docker-compose.yml`), or over SSH:

```bash
cd ~/flight-tracker
docker compose pull
docker compose up -d
```

Open `http://<nas-ip>:8090` (or whatever `FRONTEND_PORT` you set in `.env`).

## Updating

```bash
docker compose pull
docker compose up -d
```

pulls whatever's currently tagged `latest` (or `IMAGE_TAG` in `.env`, if
pinned to a specific build) and recreates the containers.

## About the two backend containers

`backend-api` and `backend-agent` are the same image, started with
different `SPRING_PROFILES_ACTIVE` — one Maven build, split at runtime, not
two separate images to publish. `backend-api` serves the REST/WebSocket
API and never calls OpenSky itself; `backend-agent` is the headless poller
that does, which is why it's the one with the OpenSky credentials in the
compose file and has no published port (nothing listens for inbound
traffic there). They coordinate only through Postgres — no Redis or other
broker — since the data volume passing between them (the poll-window
state, and one small `NOTIFY` payload per new position) is small.

## About the polling window and the global sweep

Two independent poll shapes share the same OpenSky account/credit budget
(see `OpenSkyAgent`):

- **"Hot" poll, window-gated** — scoped to whatever's currently on
  someone's map viewport (`ViewportService`). Only actively polls for 1
  minute at a time (`flighttracker.agents.poll-window-seconds`, default
  60) — it doesn't run continuously. This is deliberate: OpenSky's
  anonymous tier has a daily credit budget, and a NAS deployment left
  running would burn through it unattended (we've hit this limit before —
  see project memory).
  - On `backend-agent` container start, the window opens automatically for
    one minute.
  - Once it elapses, the map stops updating and the header shows "Watch
    Stood Down" with a "Resume Watch" button — click it (or the "Stop
    Watch" button while it's running) to reopen/close the window.
  - `POST /api/agents/restart` / `POST /api/agents/stop` do the same thing
    directly, if you'd rather script it than click the button each time.
- **Global sweep, always on** — every aircraft OpenSky reports worldwide,
  regardless of whether anyone's watching, every
  `flighttracker.agents.global-sweep-interval-seconds` (default 300 = 5
  minutes), independent of the window above. This is what lets the map
  show recent data the moment you pan somewhere the hot poll has never
  targeted. A full-world request costs meaningfully more of OpenSky's
  per-account credit budget than a bbox-scoped one — on the free anonymous
  tier this can plausibly exhaust the daily budget on its own well before
  the day is out, in which case the existing backoff logic just skips
  cycles until it resets (degraded, not broken). A registered OpenSky
  account (`OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` in `.env` — see
  `.env.example`) has a much larger budget if you want reliable global
  coverage; note that today those credentials only cover the
  origin/destination enrichment lookup (`OpenSkyFlightsClient`), not the
  state-vector polling itself.
