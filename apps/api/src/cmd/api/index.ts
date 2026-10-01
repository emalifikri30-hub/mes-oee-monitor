import { serve } from "@hono/node-server";

import app, { container } from "./app.js";
import { getOtelSdk } from "@molca/observability";

async function main() {
  const server = serve({ fetch: app.fetch, port: Number(process.env.PORT) }, (info) => {
    console.log(`listening on :${info.port}`);
  });

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
