# bff

Backend-for-Frontend (Hono + Node). It owns the **OIDC login flow** and the **httpOnly session
cookie**, and exposes a hardened **proxy** (`/api/proxy/*`) that injects the user's bearer token and
forwards allow-listed requests to `core-api`. The `web` app talks only to this service.

- **Port:** `3001`
- **Build output:** `dist/index.js` (deps externalized → needs `node_modules` at runtime)
- **Key routes:** `GET /api/login`, `GET /api/callback`, `GET /api/me`, `POST /api/token/refresh`,
  `GET|POST /api/logout`, `ALL /api/proxy/*`, `GET /health/*`

## Prerequisites

- Node `>=22.12.0`, pnpm `11.8.0` (via `corepack enable`)
- [Vite+](https://viteplus.dev) — the `vp` CLI (installed automatically by `pnpm install`)

## Environment variables

Copy/adjust `apps/bff/.env`. **Required** (startup fails if missing):

| Variable                                | Description                                              |
| --------------------------------------- | -------------------------------------------------------- |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | OIDC client credentials                                  |
| `OIDC_BASE_URI`                         | Issuer base URI (Keycloak realm)                         |
| `OIDC_REDIRECT_URI`                     | Callback URL registered with the IdP (`…/api/callback`)  |
| `OIDC_CLIENT_SCOPE`                     | e.g. `openid profile email organization`                 |
| `COOKIE_NAME` / `COOKIE_SECRET`         | Session cookie name + signing secret                     |
| `CLIENT_BASE_REDIRECT_URI`              | Where to send the browser after login (the `web` origin) |
| `CORE_API_BASE_URL`                     | Upstream `core-api` base URL                             |
| `PROXY_ALLOWED_PREFIXES`                | Comma-separated allow-list, e.g. `/api/v1,/health`       |
| `REGION_CODE`                           | Region tag                                               |

**Optional:** `PORT` (default 3001), `CORS_ALLOWED_ORIGINS` (default `http://localhost:3000`),
`PROXY_UPSTREAM_TIMEOUT_MS` (default 30000).

> **Not an env var, but easy to miss:** where login may return the browser is allow-listed in code,
> by `ALLOWED_PREFIXES` in `src/module/auth/auth-service.ts`. It must match the `web` route set
> (see [`apps/web/README.md`](../web/README.md#routes)) — anything else is silently rewritten to
> `/`, so a post-login deep link just loses its destination. This is **not** the same mechanism as
> `PROXY_ALLOWED_PREFIXES` above, which gates upstream API paths.

## Local development

```bash
pnpm install          # from the repo root
pnpm dev:bff          # or: vp run bff#dev
```

## Checks, tests, build

```bash
pnpm --filter bff run check    # format + lint + types
pnpm --filter bff run test     # vitest
pnpm --filter bff run build    # tsc && vp build -> dist/index.js
pnpm --filter bff start        # node dist/index.js
```

## Docker

Built from the **repo root** (the build needs the workspace lockfile):

```bash
docker build -f apps/bff/Dockerfile -t template-bff .
docker run --rm -p 3001:3001 --env-file apps/bff/.env template-bff
```

> **Note:** `docker run --env-file` does **not** strip quotes. Use unquoted values in the env file
> passed to `docker run` (Docker Compose and Kubernetes handle quoting correctly).

The image is multi-stage (`node:22-alpine`): the runtime stage carries only production
`node_modules` + `dist` + `package.json` and runs as the non-root `node` user.

CI: `.github/workflows/bff.yaml`. The `release-image` job pushes to Docker Hub and **requires the
`DOCKERHUB_*` secrets/variable** documented in the [root README](../../README.md#cicd--docker-hub).
