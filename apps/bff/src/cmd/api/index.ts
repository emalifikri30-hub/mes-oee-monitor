import { serve } from "@hono/node-server";

import app, { container } from "./app.js";
import { getOtelSdk } from "@molca/observability";

async function main() {
  const server = serve({ fetch: app.fetch, port: Number(process.env.PORT) }, (info) => {
    // NAMES THE UPSTREAM, not just the port it bound.
    //
    // This process is a proxy, so "listening on :3001" is only half of what a
    // developer needs to know — and the missing half is what let a stale api on
    // :3002 serve a whole browsing session from a seeded scratch database while
    // the real one sat unused on :3003. The stack looked healthy from every angle
    // except the data. One line makes the wiring visible at boot instead of
    // requiring lsof to reconstruct it.
    //
    // Read from the environment rather than from the resolved config, because
    // config.ts throws on a missing variable and this log must not be the thing
    // that reports that.
    console.log(
      `listening on :${info.port} -> core-api ${process.env.CORE_API_BASE_URL ?? "(unset)"}`,
    );
  });

  // graceful shutdown: close the server & dispose container resources
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await container.dispose();
    await getOtelSdk()
      ?.shutdown()
      .catch((err: unknown) => console.error("otel shutdown failed", err));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("failed to start ", err);
  process.exit(1);
});
