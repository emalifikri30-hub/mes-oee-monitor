import { defineConfig, loadEnv } from "vite-plus";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { lazyPlugins } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";

const env = loadEnv("development", process.cwd(), "");
const BFF_TARGET = env.BFF_URL || "http://localhost:3001";

// https://vite.dev/config/
export default defineConfig({
  // `@/*` -> `src/*`, mirroring `paths` in tsconfig.app.json. Both are required:
  // TypeScript resolves types through tsconfig, the bundler through this alias.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // STRICT, so a busy port is an error rather than a silent move to the next
    // one. Vite's default is to increment: with 3002 already held by a stale api
    // process, `pnpm dev:all` came up looking healthy while the BFF kept talking
    // to that stale server — a browser showing 62 fabricated rows against a table
    // DBeaver reported as empty. Failing to bind is the diagnosis; moving is not.
    strictPort: true,
    port: parseInt(env.PORT) || 3000,
    // Proxy auth + API calls to the BFF so the browser stays same-origin and
    // the httpOnly session cookie is sent automatically. `/api/login`,
    // `/api/callback` and `/api/logout` issue redirects, so don't rewrite them.
    proxy: {
      "/api": { target: BFF_TARGET, changeOrigin: true },
      "/health": { target: BFF_TARGET, changeOrigin: true },
    },
  },
  // Two kinds of test live here, and the split is deliberate.
  //
  // MOST logic still belongs in a pure `src/lib/*.ts` with a colocated test:
  // lib/format.ts, lib/waterfall.ts, lib/product-count.ts, lib/perf-hourly.ts,
  // lib/pareto.ts. Those hold the arithmetic and the time-zone handling that
  // would otherwise fail as plausible-looking wrong numbers rather than as an
  // error, and they are far cheaper to cover exhaustively as functions than
  // through a rendered tree. A new card's risky logic should still go there
  // first.
  //
  // What the DOM environment adds is the part no pure function can reach: which
  // state a card SELECTS. Every fetching card has a pending, an error, an empty
  // and a populated branch, and one more that is easy to miss — a query gated
  // off by `enabled: false` reports `status: "pending"` forever, so a card that
  // reads isPending first renders a skeleton that never resolves. That shipped
  // in two cards before anything caught it, because nothing could.
  //
  // happy-dom rather than jsdom: @testing-library/react works with either, and
  // this is the lighter of the two for a suite that renders single cards.
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  // src/routeTree.gen.ts is rewritten by @tanstack/router-plugin on every dev/build
  // run and it formats the file itself. Leave it alone so oxfmt and the generator
  // don't overwrite each other forever. The root vite.config.ts repeats this
  // pattern, because the pre-commit hook (`vp staged`) runs the root config.
  fmt: {
    ignorePatterns: ["src/routeTree.gen.ts"],
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn", "react"],
    categories: {
      correctness: "warn",
    },
    env: {
      builtin: true,
    },
    ignorePatterns: ["dist", "**/routeTree.gen.ts"],
    overrides: [
      {
        files: ["**/*.{ts,tsx}"],
        rules: {
          "constructor-super": "error",
          "for-direction": "error",
          "getter-return": "error",
          "no-async-promise-executor": "error",
          "no-case-declarations": "error",
          "no-class-assign": "error",
          "no-compare-neg-zero": "error",
          "no-cond-assign": "error",
          "no-const-assign": "error",
          "no-constant-binary-expression": "error",
          "no-constant-condition": "error",
          "no-control-regex": "error",
          "no-debugger": "error",
          "no-delete-var": "error",
          "no-dupe-class-members": "error",
          "no-dupe-else-if": "error",
          "no-dupe-keys": "error",
          "no-duplicate-case": "error",
          "no-empty": "error",
          "no-empty-character-class": "error",
          "no-empty-pattern": "error",
          "no-empty-static-block": "error",
          "no-ex-assign": "error",
          "no-extra-boolean-cast": "error",
          "no-fallthrough": "error",
          "no-func-assign": "error",
          "no-global-assign": "error",
          "no-import-assign": "error",
          "no-invalid-regexp": "error",
          "no-irregular-whitespace": "error",
          "no-loss-of-precision": "error",
          "no-misleading-character-class": "error",
          "no-new-native-nonconstructor": "error",
          "no-nonoctal-decimal-escape": "error",
          "no-obj-calls": "error",
          "no-prototype-builtins": "error",
          "no-redeclare": "error",
          "no-regex-spaces": "error",
          "no-self-assign": "error",
          "no-setter-return": "error",
          "no-shadow-restricted-names": "error",
          "no-sparse-arrays": "error",
          "no-this-before-super": "error",
          "no-unassigned-vars": "error",
          "no-undef": "error",
          "no-unexpected-multiline": "error",
          "no-unreachable": "error",
          "no-unsafe-finally": "error",
          "no-unsafe-negation": "error",
          "no-unsafe-optional-chaining": "error",
          "no-unused-labels": "error",
          "no-unused-private-class-members": "error",
          "no-unused-vars": "error",
          "no-useless-assignment": "error",
          "no-useless-backreference": "error",
          "no-useless-catch": "error",
          "no-useless-escape": "error",
          "no-with": "error",
          "preserve-caught-error": "error",
          "require-yield": "error",
          "use-isnan": "error",
          "valid-typeof": "error",
          "no-array-constructor": "error",
          "no-unused-expressions": "error",
          "typescript/ban-ts-comment": "error",
          "typescript/no-duplicate-enum-values": "error",
          "typescript/no-empty-object-type": "error",
          "typescript/no-explicit-any": "error",
          "typescript/no-extra-non-null-assertion": "error",
          "typescript/no-misused-new": "error",
          "typescript/no-namespace": "error",
          "typescript/no-non-null-asserted-optional-chain": "error",
          "typescript/no-require-imports": "error",
          "typescript/no-this-alias": "error",
          "typescript/no-unnecessary-type-constraint": "error",
          "typescript/no-unsafe-declaration-merging": "error",
          "typescript/no-unsafe-function-type": "error",
          "typescript/no-wrapper-object-types": "error",
          "typescript/prefer-as-const": "error",
          "typescript/prefer-namespace-keyword": "error",
          "typescript/triple-slash-reference": "error",
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "warn",
          "react/only-export-components": [
            "error",
            {
              allowConstantExport: true,
              // `createFileRoute(path)({ component })` and
              // `createRootRouteWithContext<T>()({ component })` wrap the route
              // component. Declaring them as HOCs lets oxlint treat the `Route`
              // export as a component export, so route files can keep their
              // component local — the shape the router plugin scaffolds.
              customHOCs: ["createFileRoute", "createRootRouteWithContext"],
              // shadcn/ui exports its cva variant helper next to the component;
              // both are HMR-safe.
              allowExportNames: ["buttonVariants", "badgeVariants"],
            },
          ],
        },
        env: {
          browser: true,
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  plugins: lazyPlugins(() => [
    // Must come first: the plugin rewrites route files before babel/react-compiler
    // touches them, and with autoCodeSplitting on it throws a plugin-order error
    // if it sits after @vitejs/plugin-react.
    // Note: lazyPlugins means this does NOT run during `vp check` — that's why
    // src/routeTree.gen.ts is committed rather than generated on demand.
    tanstackRouter({
      target: "react",
      // Stated explicitly (they match the defaults) because the fmt/lint ignore
      // patterns above and the CI freshness check both hardcode these paths.
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
      semicolons: true,
      // ON since 2026-08-25, and it works against rolldown-vite — which was the
      // stated blocker (TODOS.md §26). Measured: the entry chunk went from
      // 804.45 kB to 395.11 kB raw, 241.55 kB to 118.60 kB gzipped, with per-route
      // chunks for _app, by-shift, the detail report, the Losses page and its
      // drill-down.
      //
      // THE FIVE HAND-ROLLED CHART SPLITS ARE STILL NEEDED, AND §26 PREDICTED THE
      // OPPOSITE. It said flipping this "should retire all four" (five by the time
      // anyone did it). Measuring says no: delete them and recharts is hoisted INTO
      // the entry chunk — CartesianChart stops being a separate 336 kB chunk and
      // the entry goes back to 781.26 kB, worse for /login than route splitting
      // alone buys.
      //
      // THE REASON IS ROLLDOWN'S CHUNKING, NOT THIS FLAG. A module reachable from
      // SEVERAL async chunks gets lifted to their common ancestor, and with
      // route-level splitting the chart cards live in three different route chunks
      // (the detail report, the Losses page, the per-reason drill-down). Their
      // common ancestor is the entry. The `lazy()` boundaries give recharts an
      // async chunk of its own, which is what keeps it out.
      //
      // So the two mechanisms are complementary rather than redundant, and the
      // comment in each of these five now says so rather than blaming this flag:
      //
      //   components/report/waterfall-card.tsx
      //   components/report/hourly-production-body.tsx
      //   components/report/reason-pareto-card.tsx
      //   components/report/quality-pareto-card.tsx
      //   components/report/others-pareto-card.tsx
      //
      // Re-measure with `vp build` before changing any of this. §26 mis-stated its
      // own baseline three times because each figure was written down and then
      // trusted.
      autoCodeSplitting: true,
    }),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ]),
});
