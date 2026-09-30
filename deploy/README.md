# Deploying

The app is a single JVM process now (see `docs/cloud-migration/PLAN.md`):
one jar, SQLite, no containers. It deploys automatically to a Hetzner VM
over SSH through Cloudflare Access whenever `main` is green
(`.github/workflows/build-deploy.yml`).

For operating the box — logs, restart, rollback, `sqlite3` shell, disk
usage — see [`hetzner/README.md`](hetzner/README.md).

The previous NAS deployment (Docker Compose, four containers, Postgres,
images published to GHCR) is retired as of the cloud migration's merge to
`main`. `docker-compose.yml`, `deploy/docker-compose.yml`,
`deploy/.env.example`, the per-service `Dockerfile`s and the
`docker-publish.yml`/`blackbox-tests.yml` workflows that supported it are
gone — see `docs/cloud-migration/PLAN.md` and
`docs/cloud-migration/reports/` for the history if you need it.
