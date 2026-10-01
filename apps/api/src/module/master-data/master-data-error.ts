import { HTTPException } from "hono/http-exception";

// Why a dedicated error type rather than throwing HTTPException directly:
//
// Every master-data failure has to be answerable from Prometheus without
// reading a log line, and `mapDomainError` only knows how to pass an
// HTTPException through — anything else becomes an undifferentiated 500. Naming
// the cause as a FIELD means the same value drives the metric label, the log
// metadata and the HTTP status, so those three can never disagree about what
// went wrong.

// One label per distinct operator action:
//   timeout       -> upstream is slow; look at mes-master-data latency
//   network_error -> upstream is unreachable; look at DNS/routing/pods
//   http_error    -> upstream answered with a failure; look at `status`
//   auth_error    -> token rejected even after a refresh; look at Keycloak
//   parse_error   -> upstream's response shape changed; look at the contract
type MasterDataErrorCause =
  | "timeout"
  | "network_error"
  | "http_error"
  | "auth_error"
  | "parse_error";

type MasterDataErrorOptions = {
  cause: MasterDataErrorCause;
  operation: string;
  message: string;
  status?: number;
};

class MasterDataError extends Error {
  readonly errorCause: MasterDataErrorCause;
  readonly operation: string;
  readonly status?: number;

  constructor({ cause, operation, message, status }: MasterDataErrorOptions) {
    super(message);
    this.name = "MasterDataError";
    // Deliberately NOT named `cause`: Error already defines `cause` as the
    // wrapped-error slot, and shadowing it with a string breaks anything that
    // walks the cause chain (including serializeError).
    this.errorCause = cause;
    this.operation = operation;
    this.status = status;
  }

  // The shape both the metric label set and the structured log read from, so a
  // dashboard and a log line always describe the same failure the same way.
  toMetadata(): Record<string, string | number> {
    return {
      master_data_operation: this.operation,
      master_data_cause: this.errorCause,
      ...(this.status === undefined ? {} : { master_data_status: this.status }),
    };
  }
}

function isMasterDataError(err: unknown): err is MasterDataError {
  return err instanceof MasterDataError;
}

// Upstream is the reason the request cannot be served, so 502 — not 500, which
// would read as a bug in this service. The cause rides in the message so the
// operator sees WHICH upstream failure without opening a log.
//
// Lives here rather than on a service because every caller of this client needs
// the identical mapping, and `mapDomainError` only passes an HTTPException
// through — a MasterDataError reaching it becomes an undifferentiated 500.
//
// `what` completes the sentence "could not <what>", e.g. "list areas".
function upstreamUnavailable(err: unknown, what: string): HTTPException {
  if (err instanceof HTTPException) return err;

  const cause = isMasterDataError(err) ? err.errorCause : "unknown";
  return new HTTPException(502, {
    message: `master data unavailable: could not ${what} (${cause})`,
    cause: err,
  });
}

// A shift window cannot be computed without a time zone, and no cached value is
// available to fall back on — see TimeZoneResolver for the fallback that makes
// this the LAST resort rather than the first.
//
// 503, not the 502 above. The distinction is real: 502 says "upstream answered
// badly", which is the honest answer for a passthrough proxy route. 503 says
// "this service cannot serve this request right now, retry" — and it is
// genuinely retryable here, because one successful resolution repopulates the
// cache and un-breaks every subsequent request for that scope.
//
// A 404 is passed through as a 404: it means the scope itself does not exist
// upstream, which is the caller's error, not an outage.
function timeZoneUnresolvable(err: unknown, scope: string, scopeId: number): HTTPException {
  if (err instanceof HTTPException) return err;

  const cause = isMasterDataError(err) ? err.errorCause : "unknown";

  if (isMasterDataError(err) && err.status === 404) {
    return new HTTPException(404, {
      message: `no such ${scope}: ${scopeId}`,
      cause: err,
    });
  }

  return new HTTPException(503, {
    message: `time zone unresolvable for ${scope} ${scopeId} (${cause})`,
    cause: err,
  });
}

export { MasterDataError, isMasterDataError, timeZoneUnresolvable, upstreamUnavailable };
export type { MasterDataErrorCause, MasterDataErrorOptions };
