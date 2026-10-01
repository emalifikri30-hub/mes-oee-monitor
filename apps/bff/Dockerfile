# syntax=docker/dockerfile:1.7
# Build from the REPO ROOT:  docker build -f apps/bff/Dockerfile -t template-bff .

# ---- builder: install all deps + build the bundle ----
FROM node:22-alpine AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Resilient package fetches (slow/flaky registry mirrors, CI runners).
ENV npm_config_fetch_timeout=600000 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000
# git is required by the root `prepare` script (vp config sets up git hooks).
# openssh-client is required to fetch @molca/mes over git+ssh — the alpine base
# image ships neither, and git alone cannot speak ssh://.
RUN apk add --no-cache git openssh-client && corepack enable
WORKDIR /repo

# Pin GitHub's host key so the fetch below is not prompted (and cannot be
# silently MITM'd by StrictHostKeyChecking=no).
RUN mkdir -p -m 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts

# Copy manifests first so the install layer is cached until a manifest changes.
# All workspace manifests are copied so pnpm links the @molca/* workspace deps.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json                   apps/api/package.json
COPY apps/bff/package.json                   apps/bff/package.json
COPY apps/web/package.json                   apps/web/package.json
COPY packages/contract-client/package.json   packages/contract-client/package.json
COPY packages/helper/package.json            packages/helper/package.json
COPY packages/network/package.json           packages/network/package.json
COPY packages/observability/package.json     packages/observability/package.json
COPY packages/utils/package.json             packages/utils/package.json
# --mount=type=ssh forwards the caller's agent for the @molca/mes git dependency.
# Build with `docker build --ssh default ...`; CI needs a deploy key in ssh-agent.
RUN --mount=type=ssh --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Build (tsc && vp build -> dist/index.js, with deps externalized).
# `bff...` builds bff AND its workspace deps (@molca/*) in topological order —
# the app's tsc/bundle needs each dep's built dist (its exports point at dist/).
COPY . .
RUN pnpm --filter "bff..." run build
# Produce a self-contained, prod-only node_modules (no symlinks) for the runtime stage.
# --legacy: use the pre-v10 deploy that resolves workspace deps from the store.
# `pnpm deploy` re-resolves the dependency graph, so it re-fetches the
# @molca/mes git dependency and needs the agent just as the install did.
RUN --mount=type=ssh pnpm --filter bff deploy --prod --legacy /out

# ---- runtime: slim image with only prod deps + the bundle ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
# dist is gitignored, so it may be omitted by `pnpm deploy` — copy it explicitly.
COPY --from=builder /repo/apps/bff/dist ./dist
COPY --from=builder /repo/apps/bff/package.json ./package.json
# OTel preload — installs instrumentation hooks before the bundle loads.
COPY --from=builder /repo/apps/bff/instrumentation.mjs ./instrumentation.mjs
USER node
EXPOSE 3001
CMD ["node", "--import", "./instrumentation.mjs", "dist/index.js"]
