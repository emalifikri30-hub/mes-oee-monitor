import { serializeError } from "./serializer.js";

import type { ILogLayer } from "loglayer";

// The app logger is a LogLayer instance. Aliased here so call sites read as a
// generic "logger" and the concrete library stays a single import to swap.
type Logger = ILogLayer;

// Wraps an async operation: on failure it logs the event, context and a
// serialized error (as structured metadata, correlated with the active trace),
// then rethrows. Success is silent.
async function withLog<T>(
  logger: Logger,
  event: string,
  ctx: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.withMetadata({ event, ...ctx, err: serializeError(err) }).error(event);
    throw err;
  }
}

export { withLog };
export type { Logger };
