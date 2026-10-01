// Prod OTel preload — loaded via `node --import ./instrumentation.mjs dist/index.js`.
//
// This file lives at the package root and is NOT part of the SSR bundle, so it
// runs in real Node module space and installs the require/import instrumentation
// hooks BEFORE the bundled app is evaluated — the http and undici patches only
// take effect if they are in place before those modules are first loaded.
//
// Database spans do NOT come from here. postgres.js has no OTel instrumentation
// to install, so the repositories emit their client spans by hand through the
// `traced()` helper in src/shared/database/postgres.ts.
//
// It is intentionally self-contained (duplicates src/shared/observability/otel.ts)
// because the built app is a single bundled file with no importable otel module.
// Keep the two in sync. The started SDK is stashed on globalThis so the bundled
// index.ts can flush it on shutdown via getOtelSdk().
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

if (process.env.OTEL_SDK_DISABLED !== "true" && !globalThis.__OTEL_SDK__) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MILLIS ?? 60000),
    }),
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();
  globalThis.__OTEL_SDK__ = sdk;
}
