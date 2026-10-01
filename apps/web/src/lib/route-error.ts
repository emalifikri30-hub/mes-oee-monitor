import { isAxiosError } from "axios";

// Is this the kind of failure a route should turn into `notFound()` rather than
// let reach the error boundary?
//
// The distinction matters more than it looks. A 404 or a 400 from core-api means
// the id in the URL does not name anything — a broken or stale link, which
// deserves a calm "not found" page with a way back. Anything else is a real
// fault and belongs on the error boundary, where it is visible and reportable.
// Collapsing the two would turn every outage into "this report does not exist".
//
// 400 counts because core-api answers a non-numeric id with one: from the
// browser's side that is the same broken link, arriving through a different
// door. (The routes also guard the id before it reaches the network, so a 400
// here means core-api rejected something the client thought was well-formed.)
//
// 401 is deliberately absent: the axios refresh interceptor owns that path, and
// anything still surfacing as a 401 here is a genuine auth failure.
function isNotFoundError(error: unknown): boolean {
  if (!isAxiosError(error)) return false;

  const status = error.response?.status;
  return status === 404 || status === 400;
}

export { isNotFoundError };
