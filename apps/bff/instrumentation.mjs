// Prod OTel preload — loaded via `node --import ./instrumentation.mjs dist/index.js`.
//
// Lives at the package root and is NOT part of the SSR bundle, so it runs in
// real Node module space and installs the instrumentation hooks before the
// bundled app evaluates. Intentionally self-contained (duplicates
// src/shared/observability/otel.ts) — keep the two in sync. The started SDK is
// stashed on globalThis so the bundled index.ts can flush it on shutdown.
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
