# template-api-with-bff

A production-shaped **Vite+ pnpm monorepo** template: a React SPA behind a Backend-for-Frontend
that owns auth, in front of a **modular-monolith** domain API backed by PostgreSQL. Use it as a
starting point for new services — see [Using this as a template](#using-this-as-a-template).

## Architecture

```
            browser
               │  (same-origin: /api, /health)
        ┌──────▼───────┐        ┌──────────────┐        ┌────────────────────────────┐
        │     web      │  proxy │     bff      │  proxy │            api             │
        │ React SPA    │───────▶│ Hono :3001   │───────▶│ Hono :3002  (modular       │──▶ PostgreSQL
        │ nginx :80    │        │ OIDC + cookie│ +bearer│ monolith) JWT-protected    │
        └──────────────┘        └──────┬───────┘        │  ┌───────────┐             │
                                       │ OIDC           │  │ work-unit │             │
                                  ┌────▼─────┐          │  │  module   │             │
                                  │   IdP    │          │  └─────┬─────┘             │
                                  │(Keycloak)│          └────────┼───────────────────┘
                                  └────▲─────┘                   │ HTTP + bearer
                                       │  client_credentials     ▼
                                       └──────────────┬─── mes-master-data (separate repo,
                                                           separate deployment)
```

- **`web`** — React 19 SPA: TanStack Router (file-based routing) + TanStack Query + shadcn/ui on
  Tailwind v4. Static build; talks to the BFF same-origin.
- **`bff`** — Hono. OIDC login, httpOnly session cookie, and a hardened proxy that injects the
  bearer token toward `api`.
- **`api`** — Hono + PostgreSQL (postgres.js, no ORM). JWT-protected domain API (`/api/v1/*`). A **modular
  monolith**: each domain lives as a separate module in one process (currently `work-unit`).
  Modules talk through the **`@molca/contract-client`** interface, never each other's internals.
  That interface is also the boundary to _other services_: `MasterDataClient` is an HTTP impl of
  `MasterDataClientContract` calling `mes-master-data`, and swapping it for a gRPC or in-process
  impl needs no change at any call site.

  It connects to **two of the three medallion tiers**, injected as `goldDb` and `silverDb`.
  Note that **schema owner and writer are different roles** — this repo owns Gold's DDL but is not
  its bulk writer:

  | Tier       | Store                                                      | This service  | Schema owner                                                                                         | Written by                                                         |
  | ---------- | ---------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
  | **Bronze** | TimescaleDB, raw ingest                                    | not connected | the `vitual-factory` repo — `docs/timescale-schema.sql`                                              | **Telegraf**                                                       |
  | **Silver** | TimescaleDB (`SILVER_DATABASE_URL`), HOT machine telemetry | **read-only** | not yet owned by any checked-in repo                                                                 | **Apache Flink**                                                   |
  | **Gold**   | Postgres (`GOLD_DATABASE_URL`), COLD aggregated reports    | read-write    | **this repo** — `apps/api/src/shared/database/migration/`, applied by `pnpm --filter api db:migrate` | **Apache Airflow → dbt**; this service for operator mutations only |

  Silver connections open with `default_transaction_read_only`, so a stray write fails loudly.
  `/health/readiness` probes both tiers independently and reports them as `gold` and `silver`.
  Silver is the near-realtime tier and is what `/dashboard` will read; Gold is cold and serves the
  reports.

  **Gold's write ownership is a contract with an external pipeline** —
  see [`docs/gold-write-contract.md`](docs/gold-write-contract.md). Airflow/dbt does every bulk
  write, directly against the database rather than through this API; this service writes only
  named operator mutations (approving a shift report, editing a downtime). `SILVER_DATABASE_URL`
  currently points at the Gold database as a placeholder while Silver is in R&D.

Each app has its own README with env vars and details:
[`apps/web`](apps/web/README.md) · [`apps/bff`](apps/bff/README.md) ·
[`apps/api`](apps/api/README.md).

## Prerequisites

- **Node** `>=22.12.0`
- **pnpm** `11.8.0` — `corepack enable` (pinned via `packageManager`)
- **[Vite+](https://viteplus.dev)** — the `vp` CLI, installed automatically by `pnpm install`
- For full local runtime: a **PostgreSQL** database and an **OIDC** client (Keycloak)

## Quickstart

```bash
pnpm install            # or: vp install

# run everything (web :3000, bff :3001, api :3002)
pnpm dev:all

# or run one app
pnpm dev:web            # vp run web#dev
pnpm dev:bff            # vp run bff#dev
pnpm dev:api            # vp run api#dev
```

Configure each app's `.env` first (copy the committed examples and fill in OIDC / DB / cookie
values). Then open http://localhost:3000.

## Onboarding: from zero to running locally

The step-by-step version of the quickstart above, for a developer setting this repo up for the
first time.

### 1. Prerequisites

| Tool / access               | Version / detail                                                                   | Check                                  |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| **Node.js**                 | `>=22.12.0`                                                                        | `node -v`                              |
| **pnpm**                    | `11.8.0`, pinned via `packageManager` — run `corepack enable` once                 | `pnpm -v`                              |
| **Git + SSH key on GitHub** | Your key must have read access to `molca-id/mes-shared` (the `@molca/mes` package) | `ssh -T git@github.com`                |
| **Docker**                  | For a local Postgres and the observability stack                                   | `docker version`                       |
| **Keycloak access**         | A realm plus two clients — ask the team lead for the values (see below)            | —                                      |
| **mes-master-data**         | A reachable instance — work-unit / work-center / area records come from there      | shared dev URL, or run it locally (§7) |
| `psql`                      | Needed to apply the optional dev seeds                                             | `psql --version`                       |

The [Vite+](https://viteplus.dev) `vp` CLI is a dev dependency — `pnpm install` brings it, nothing
to install globally.

**Keycloak clients you need:**

- **BFF client** (`apps/bff/.env` → `OIDC_CLIENT_ID`, normally `mes-oee-monitor`): a
  _confidential_ client with `http://localhost:3001/api/callback` registered as a Valid Redirect
  URI.
- **api client** (`apps/api/.env` → `OIDC_CLIENT_ID`): a client with **service accounts enabled**;
  the api uses it (client-credentials grant) to call mes-master-data.

### 2. Clone and install

```bash
git clone <repo-url> mes-oee-monitor    # SSH URL from GitHub
cd mes-oee-monitor
corepack enable
pnpm install
pnpm --filter "./packages/*" run build   # build the shared @molca/* packages once
```

The last line matters on a fresh checkout: `packages/*` export from their `dist/`, which is
gitignored, so `pnpm dev:api` / `pnpm dev:bff` and `vp check` cannot resolve `@molca/*` until it
has been built. Re-run it after pulling changes to a package.

If `pnpm install` fails on `git+ssh://git@github.com/molca-id/mes-shared.git`, your SSH key either
is not loaded (`ssh-add -l`) or has no access to that repo — ask for access before going further.

### 3. Start a local Postgres (Gold)

```bash
docker run -d --name oee-gold \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gold \
  -p 5432:5432 postgres:18-alpine
```

You only need **one** database today: Silver is still in R&D, so `SILVER_DATABASE_URL` points at the
Gold database as a placeholder (see [Architecture](#architecture)). Port `5432` already taken? Map
another one (`-p 55432:5432`) and use it in the URLs below.

### 4. Create the `.env` files

```bash
cp apps/api/.env.example apps/api/.env
cp apps/bff/.env.example apps/bff/.env
```

Then fill in at least:

| File            | Variable                                                          | Value                                              |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `apps/api/.env` | `GOLD_DATABASE_URL`                                               | `postgres://postgres:postgres@localhost:5432/gold` |
| `apps/api/.env` | `SILVER_DATABASE_URL`                                             | The **same** URL as Gold (placeholder, see above)  |
| `apps/api/.env` | `OIDC_HOST`, `OIDC_BASE_URI`, `OIDC_TOKEN_URI`, `KEYCLOAK_REALMS` | Your realm                                         |
| `apps/api/.env` | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                            | The **api** (service-account) client               |
| `apps/api/.env` | `MASTER_DATA_BASE_URL`                                            | A reachable mes-master-data api — **not** `:3002`  |
| `apps/bff/.env` | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_BASE_URI`           | The **BFF** client and your realm                  |
| `apps/bff/.env` | `COOKIE_SECRET`                                                   | Output of `openssl rand -base64 32`                |

Everything else in the examples already works for local development. Leave the opt-in variables
(`AUTH_AUDIENCE`, `AUTH_ALLOWED_AZP`, `APPROVE_ROLE`, `REOPEN_ROLE`, `EDIT_DOWNTIME_ROLE`) unset.
`.env` files are gitignored — never commit them.

### 5. Apply the Gold schema

```bash
pnpm --filter api db:migrate
```

Applies every migration in `apps/api/src/shared/database/migration/`. It is safe to re-run.

### 6. (Optional) Load dev data

In real environments Gold is filled by Airflow → dbt, not by this service, so a fresh local
database has the schema but **no reports** — every page renders empty. To get data, either:

- ask the team for a dump of the dev Gold database, or
- hand-run the dev seeds in `apps/api/scripts/seed/` with `psql`. They are **not** migrations and
  some must run in a specific order — read each file's header before running it, and run `\conninfo`
  first so you know which database you are writing to:

  ```bash
  psql "postgres://postgres:postgres@localhost:5432/gold" -f apps/api/scripts/seed/<file>.sql
  ```

The seeds' work-unit / work-center ids must match the records in the mes-master-data instance you
point at, or report rows will have no labels.

### 7. Run mes-master-data locally (only if there is no shared instance)

mes-master-data's api also defaults to port `3002`, so give it another one. In the
**mes-master-data** checkout, set `PORT=4002` in `apps/api/.env` and run only its api:

```bash
cd ../mes-master-data && pnpm dev:api     # listens on :4002
```

Then use `MASTER_DATA_BASE_URL=http://localhost:4002` here. See mes-master-data's README for
its own setup.

### 8. Start the apps

```bash
pnpm dev:all        # web :3000, bff :3001, api :3002
# or, one per terminal:
pnpm dev:api
pnpm dev:bff
pnpm dev:web
```

For traces, metrics and dashboards, also run the observability stack described under
[Observability](#observability--traces-metrics-dashboards-and-alerts) (Grafana on :3005).

### 9. Check that it works

- `curl http://localhost:3002/health/readiness` reports `gold`, `silver` and Keycloak as up.
- <http://localhost:3000> sends you to the Keycloak login, then into the app.
- The area / line pickers list real records (that confirms mes-master-data is reachable).
- `pnpm run ready` passes (check + test + build).

### Troubleshooting

| Symptom                                        | Likely cause                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Port 3000/3001/3002 is already in use`        | A stale dev server. Ports are strict on purpose — kill the old process instead of changing ports. |
| api refuses to boot listing a missing variable | A required `.env` value is empty; compare with `.env.example`.                                    |
| Readiness reports `silver` down                | `SILVER_DATABASE_URL` is unset or unreachable — point it at the Gold database for now.            |
| Pickers return 502, or 404 from `/v1/areas`    | `MASTER_DATA_BASE_URL` is unreachable, or points at `:3002` (the api calling itself).             |
| Pages load but every report is empty           | Expected on a fresh database — see step 6.                                                        |
| Keycloak shows "Invalid redirect URI"          | `OIDC_REDIRECT_URI` is not registered on the BFF client exactly as written.                       |
| Every request 401s after login                 | The BFF and api point at different realms, or you set `AUTH_AUDIENCE` / `AUTH_ALLOWED_AZP`.       |

## Common commands

| Command                                        | What it does                              |
| ---------------------------------------------- | ----------------------------------------- |
| `vp install`                                   | Install workspace dependencies            |
| `vp check`                                     | Format + lint + type-check the whole repo |
| `vp run -r test`                               | Run tests in every package                |
| `vp run -r build`                              | Build every package                       |
| `vp run ready`                                 | `check` + test + build (pre-push gate)    |
| `pnpm --filter <app> run <check\|test\|build>` | Run a task for one app                    |

## Docker

Each app has a multi-stage `Dockerfile` (built **from the repo root** — the build needs the
workspace lockfile). Server images run as non-root on `node:22-alpine` with production deps only;
the web image is nginx serving static assets + proxying to the BFF.

```bash
docker build -f apps/api/Dockerfile -t template-api .
docker build -f apps/bff/Dockerfile -t template-bff .
docker build -f apps/web/Dockerfile -t template-web .
```

Run them together with the bundled compose file (uses each app's `.env`, optional):

```bash
docker compose up --build      # web :8080 -> bff :3001 -> api :3002
```

> Database migrations are not run by the images. Apply them separately:
> `pnpm --filter api db:migrate`.

### Observability — traces, metrics, dashboards and alerts

The compose stack brings up the whole chain, so nothing here needs configuring by hand:

| URL                              | What                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| [:16686](http://localhost:16686) | **Jaeger** — traces from `api` and `bff`                                     |
| [:9090](http://localhost:9090)   | **Prometheus** — metrics, and the [Alerts tab](http://localhost:9090/alerts) |
| [:3005](http://localhost:3005)   | **Grafana** — the OEE dashboard, provisioned and ready                       |

`api` and `bff` export OTLP to the collector, which fans traces to Jaeger and re-exposes metrics on
`:8889` for Prometheus to scrape. Grafana is on **3005**, not its usual 3000, because `web` owns
that port in dev.

**The alert rules are `prometheus-alerts.yml`, and the dashboard is
`grafana/dashboards/oee-service.json`** — both checked in, both provisioned. Grafana is
deliberately **not** editable in the UI: a dashboard edited by clicking is lost on the next restart
and is not reviewable, so change the JSON.

`apps/api/src/shared/observability/metrics.ts` annotates every instrument with the PromQL that
should page somebody. Those annotations are now real rules rather than prose — **keep them in
step**, and note that a histogram exports as `_bucket` / `_count` / `_sum` while a counter keeps its
name exactly.

Anonymous admin and no login form are fine here because this is a **local development stack**. This
repo contains no deployment manifest; anything derived from this file for a real environment has to
put authentication back.

## CI/CD & Docker Hub

Per-app GitHub Actions workflows live in `.github/workflows/` (`api.yaml`, `bff.yaml`,
`web.yaml`). Each runs, on PRs and pushes to `main` (path-filtered to that app):

```
install-deps ──▶ check ─┐
             ├▶ test  ─┼▶ release-image   (web has no test job)
             └▶ build ─┘
```

`check` / `test` / `build` run in parallel; **`release-image`** runs only on push to `main` (and
manual `workflow_dispatch`), after the others pass, and builds + pushes the image to Docker Hub.

### Required secrets & variables — release-image fails until these are set

`release-image` **will fail at the Docker login step** until you add, in
**Settings → Secrets and variables → Actions**:

| Type     | Name                  | Value                                                       |
| -------- | --------------------- | ----------------------------------------------------------- |
| Secret   | `DOCKERHUB_USERNAME`  | Your Docker Hub username                                    |
| Secret   | `DOCKERHUB_TOKEN`     | A Docker Hub **access token** (Account Settings → Security) |
| Variable | `DOCKERHUB_NAMESPACE` | Docker Hub namespace (user/org) for the image names         |

Images are published as `${DOCKERHUB_NAMESPACE}/template-<app>`, tagged `latest` and the short git
SHA. The `check`/`test`/`build` jobs need no secrets and pass out of the box.

## Using this as a template

This repo is meant to be a **GitHub template repository**.

1. **Enable it** (once, on this repo): **Settings → General → check "Template repository."** A green
   **"Use this template"** button then appears on the repo home.
2. **Create a new project from it:** click **Use this template → Create a new repository**, or with
   the CLI:
   ```bash
   gh repo create my-org/my-service --template molca-id/boilerplate-hono-bff --private
   ```

**What you get** (template ≠ fork): a brand-new repository with a single fresh commit and **no
shared git history** or upstream link — you can't open PRs back to this template, and it won't
receive its updates. Things that are **not** copied and must be set up in the new repo:

- **Secrets & variables** — re-add `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `DOCKERHUB_NAMESPACE`.
- **Branch protection rules** and other repo settings.
- `.env` files (gitignored) — recreate them with your own OIDC / DB / cookie values.

**After creating**, typically: rename packages/images as needed, fill in `.env` for each app, set
the Docker Hub secrets/variable, and update these READMEs for your service.

## Vite+

This monorepo uses [Vite+](https://viteplus.dev) (`vp`). Run `vp help`, or read the local docs in
`node_modules/vite-plus/docs`. If setup/runtime looks wrong, run `vp env doctor`.
