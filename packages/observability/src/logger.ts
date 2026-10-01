import { pino } from "pino";
import { LogLayer } from "loglayer";
import { PinoTransport } from "@loglayer/transport-pino";
import { openTelemetryPlugin } from "@loglayer/plugin-opentelemetry";

import type { ILogLayer } from "loglayer";

const isProd = process.env.NODE_ENV === "production";

function createPino() {
  return pino({
    level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    // Raw JSON in prod; human-friendly pretty output in dev. pino-pretty is
    // loaded lazily as a transport target so it never runs in production.
    ...(isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true } } }),
  });
}

// openTelemetryPlugin() reads the active OTel span at log time and injects
// trace_id / span_id / trace_flags into every line — so logs correlate with
// traces automatically once the OTel SDK is running.
function createBaseLogger(): ILogLayer {
  return new LogLayer({
    transport: new PinoTransport({ logger: createPino() }),
    plugins: [openTelemetryPlugin()],
  });
}

const baseLogger = createBaseLogger();

export { baseLogger, createBaseLogger };
export type { ILogLayer };
