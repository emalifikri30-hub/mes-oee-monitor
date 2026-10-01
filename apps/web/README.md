# web

React 19 SPA (Vite+ · TanStack Router file-based routing · TanStack Query · shadcn/ui on
Tailwind v4 · axios). It talks to the `bff` **same-origin** via
relative `/api` and `/health` paths — so the browser sends the httpOnly session cookie
automatically. Axios auto-refreshes the session on `401` (`POST /api/token/refresh`) and replays
the request.

Rendering stays **client-side**: the build is static and nginx serves it, with no Node runtime for
`web`. That is a deliberate choice — see issue #3 for the SPA-vs-SSR trade-off and #2 for what a
TanStack Start (SSR) conversion would entail.

- **Dev port:** `3000`
- **Build output:** static files in `dist/` (served by nginx in production)

## Routes

File-based, under `src/routes/`. The filename _is_ the URL.

| Path     | File         | Notes                                                                                                  |
| -------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| —        | `__root.tsx` | Layout (header + `<Outlet>`), session-expiry handling, `errorComponent`, `notFoundComponent`           |
| `/`      | `index.tsx`  | Placeholder landing page. `beforeLoad` guard redirects to `/login?redirect=…`                          |
| `/login` | `login.tsx`  | Sign-in card. Reads validated `redirect` + `reason` search params; redirects away if already signed in |

Two rules worth knowing before adding routes:

- **`login()` and `logout()` must stay full-page `location.href` navigations.** `GET /api/login`
  and `GET /api/logout` answer with cross-origin 302s to the IdP, which a client-side navigation
  cannot follow — a `<Link>` would just render the not-found component.
- **The BFF gates where login may return you.** `ALLOWED_PREFIXES` in
  `apps/bff/src/module/auth/auth-service.ts` must stay in sync with the table above, or a
  post-login deep link silently lands on `/`. (Not the same thing as `PROXY_ALLOWED_PREFIXES`.)

Also note `/api/*` and `/health*` never reach the router — nginx proxies them in production and
Vite proxies them in dev — so don't create client routes under those prefixes.

### Generated route tree

`src/routeTree.gen.ts` is written by `@tanstack/router-plugin` on every `vp dev` / `vp build`. It
**is committed** and must never be hand-edited.

Committed rather than generated on demand because there is no single place a codegen step could
cover: `lazyPlugins` means the plugin does not run during `vp check`, `build` runs `tsc -b` _before_
Vite, and the pre-commit hook runs the root config. So it is excluded from oxfmt in **both**
`apps/web/vite.config.ts` and the root `vite.config.ts`, its own `/* eslint-disable */` +
`@ts-nocheck` header covers oxlint and tsc, and CI asserts freshness with
`git diff --exit-code -- apps/web/src/routeTree.gen.ts`.

`autoCodeSplitting` is **on** (measured 2026-08-25, TODOS.md §26). It halves the entry chunk:
**804.45 kB → 395.11 kB** raw, 241.55 kB → 118.60 kB gzipped, with per-route chunks for
`_app`, `by-shift`, the detail report, the Losses page and its drill-down.

**The five hand-rolled chart splits are still there, and they are still load-bearing.** §26 expected
the flag to retire them; measuring says otherwise. Delete them and recharts is hoisted **into** the
entry chunk — `CartesianChart` stops being a separate 336 kB chunk and the entry goes back to
781.26 kB, because rolldown lifts a module shared by several route chunks up to their common
ancestor, which is the entry. The `lazy()` boundaries are what keep it out. See the note beside the
flag in `vite.config.ts`.

Re-measure with `pnpm --filter web exec vp build` if you change chunking; the figures above have
drifted every time somebody trusted them instead.

## UI

shadcn/ui, `new-york` style, `neutral` base color, on Tailwind v4 CSS-first tokens in
`src/index.css`.

- `src/components/ui/*` are **repo-owned files — edit them freely.** They were seeded from the
  `new-york-v4` registry, not vendored as a dependency.
- Add more with `pnpm dlx shadcn@latest add <name> --cwd apps/web`, then **review the output**:
  shadcn v4 defaults to Base UI primitives, which would not match the Radix-based components
  checked in here. Re-home any dependency it installs into the `pnpm-workspace.yaml` catalog.
- Style with semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`), never
  hardcoded palette colors — that is what makes dark mode work.
- Dark mode is a `dark` class on `<html>`: applied before first paint by the inline script in
  `index.html` (so a reload doesn't flash white) and toggled by `components/ThemeToggle.tsx`.

## Path alias

`@/*` → `src/*`, declared in **both** `tsconfig.app.json` (`paths`) and `vite.config.ts`
(`resolve.alias`) — TypeScript reads one, the bundler the other, and both are required. There is no
`baseUrl`; TypeScript 7 removed it.

Unlike `api`/`bff`/`packages`, this app imports **without** the `.js` extension: it uses
`moduleResolution: "bundler"`, where the suffix is purely cosmetic.

## Prerequisites

- Node `>=22.12.0`, pnpm `11.8.0` (via `corepack enable`)
- A running `bff` (and `core-api`) for live data

## How it reaches the BFF

- **Dev:** the Vite dev server proxies `/api` + `/health` to the BFF. Override the target with the
  `BFF_URL` env var (default `http://localhost:3001`) — see `vite.config.ts`.
- **Prod:** the build is static and uses **relative** URLs. The nginx image (below) serves the SPA
  and reverse-proxies `/api` + `/health` to the BFF at `BFF_UPSTREAM`.

## Local development

```bash
pnpm install      # from the repo root
pnpm dev:web      # or: vp run web#dev   ->   http://localhost:3000
```

## Checks, build

```bash
pnpm --filter web run check    # format + lint + types
pnpm --filter web run build    # tsc -b && vp build -> dist/
pnpm --filter web run preview  # preview the production build
```

> Tests cover `src/lib` only — pure functions, run in the default node environment (`vp test`,
> wired into the `web` CI workflow as a `test` job). There is no DOM environment and no
> component-testing convention here: anything with real branching lives in core-api, where it can
> be tested against a repository fake. `src/lib/format.ts` is the exception that earns a suite,
> because a wrong time zone would render as plausible-looking wrong times rather than as an error.

## Docker

Built from the **repo root**. The runtime is `nginx:alpine` serving the static build + proxying to
the BFF:

```bash
docker build -f apps/web/Dockerfile -t template-web .
docker run --rm -p 8080:80 -e BFF_UPSTREAM=http://host.docker.internal:3001 template-web
# open http://localhost:8080
```

- `BFF_UPSTREAM` (default `http://bff:3001`) is substituted into the nginx config at container
  start. The proxy config lives in `apps/web/deploy/nginx.conf.template`; the SPA fallback serves
  `index.html` for client-side routes.
- Cache headers in that same template: `/assets/*` is `immutable` for a year (the filenames are
  content-hashed), while `index.html` is `no-cache`. The second half matters — a cached shell names
  hashed chunks that no longer exist in the next image, which renders a blank page after a deploy.
- Final image is small (static assets only — no Node runtime).

CI: `.github/workflows/web.yaml`. The `release-image` job pushes to Docker Hub and **requires the
`DOCKERHUB_*` secrets/variable** documented in the [root README](../../README.md#cicd--docker-hub).
