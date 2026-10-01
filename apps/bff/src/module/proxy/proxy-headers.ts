const HOP_BY_HOP: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Note: `x-trace-id`, `traceparent` and `tracestate` are intentionally NOT
// dropped — they must propagate to the upstream for end-to-end tracing.
const REQUEST_DROP: readonly string[] = [
  ...HOP_BY_HOP,
  "cookie",
  "authorization",
  "host",
  "content-length",
];

const RESPONSE_DROP: readonly string[] = [...HOP_BY_HOP, "set-cookie", "content-length"];

function filterHeaders(source: Headers, drop: readonly string[]): Headers {
  const dropSet = new Set(drop.map((h) => h.toLowerCase()));
  const out = new Headers();
  source.forEach((value, key) => {
    if (!dropSet.has(key.toLowerCase())) {
      out.append(key, value);
    }
  });
  return out;
}

export { HOP_BY_HOP, REQUEST_DROP, RESPONSE_DROP, filterHeaders };
