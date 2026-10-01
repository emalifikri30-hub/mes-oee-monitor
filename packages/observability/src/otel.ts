// OpenTelemetry SDK bootstrap (traces + metrics).
//
// IMPORTANT: this must run before any instrumented module is loaded.
//  - prod: started via `node --import ./instrumentation.mjs dist/index.js`
//    (instrumentation.mjs duplicates the SDK config below and stashes the
//     instance on globalThis.__OTEL_SDK__ before the bundle evaluates).
//  - dev: started by the first-line `startOtel()` call in cmd/api/app.ts,
//    which @hono/vite-dev-server loads as the entry. Module-patching
//    instrumentation (e.g. pg) is best-effort in dev because Vite transforms
//    the module graph; @hono/otel + undici (diagnostics_channel) still work.
//
// HTTP + undici instrumentations are always installed. Apps add their own
// (e.g. PgInstrumentation for Postgres services) by passing `instrumentations`
// so transport-specific deps stay in the app, not in this shared package.
//
// Keep the instrumentations/exporters here in sync with each app's instrumentation.mjs.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

type SdkInstrumentations = NonNullable<
  ConstructorParameters<typeof NodeSDK>[0]
>["instrumentations"];

type StartOtelOptions = {
  // Extra instrumentations to install alongside the always-on HTTP + undici.
  instrumentations?: SdkInstrumentations;
};

declare global {
  // eslint-disable-next-line no-var
  var __OTEL_SDK__: NodeSDK | undefined;
}

let sdk: NodeSDK | undefined;

// Idempotent: safe across dev HMR and against a prod preload that already
// started the SDK (reused via globalThis). Service name / resource attrs /
// OTLP endpoint are all read from the standard OTEL_* env vars.
function startOtel(options: StartOtelOptions = {}): NodeSDK | undefined {
  if (sdk) return sdk;
  if (globalThis.__OTEL_SDK__) {
    sdk = globalThis.__OTEL_SDK__;
    return sdk;
  }
  if (process.env.OTEL_SDK_DISABLED === "true") return undefined;

  const extra = options.instrumentations ?? [];

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MILLIS ?? 60000),
    }),
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation(), ...extra],
  });
  sdk.start();
  globalThis.__OTEL_SDK__ = sdk;
  return sdk;
}

function getOtelSdk(): NodeSDK | undefined {
  return sdk ?? globalThis.__OTEL_SDK__;
}

export { startOtel, getOtelSdk };
export type { StartOtelOptions };
