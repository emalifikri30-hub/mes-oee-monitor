import { defineConfig, loadEnv } from "vite-plus";
import devServer from "@hono/vite-dev-server";

const env = loadEnv("development", process.cwd(), "");

export default defineConfig({
  server: {
    // STRICT, so a busy port is an error rather than a silent move to the next
    // one. Vite's default is to increment: with 3002 already held by a stale api
    // process, `pnpm dev:all` came up looking healthy while the BFF kept talking
    // to that stale server — a browser showing 62 fabricated rows against a table
    // DBeaver reported as empty. Failing to bind is the diagnosis; moving is not.
    strictPort: true,
    port: parseInt(env.PORT) || 3001,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
  build: {
    ssr: "./src/cmd/api/index.ts",
    outDir: "dist",
    rollupOptions: {
      // Keep modules that OpenTelemetry patches at runtime un-bundled so the
      // require/import hooks installed by instrumentation.mjs can intercept
      // them, and keep pino's transport workers resolvable by name.
      external: [/^@opentelemetry\//, "pino", "pino-pretty", "thread-stream"],
      output: {
        entryFileNames: "index.js",
      },
    },
  },
  plugins: [
    devServer({
      entry: "./src/cmd/api/app.ts",
    }),
  ],
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
