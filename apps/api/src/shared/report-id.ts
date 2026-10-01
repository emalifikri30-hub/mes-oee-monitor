import { HTTPException } from "hono/http-exception";

// THE :id ROUTE PARAM, VALIDATED ONCE FOR EVERY REPORT SUBJECT.
//
// Route params are unvalidated strings; a non-numeric id must be a 400 and must
// never reach a repository as NaN, which would silently match no rows and become a
// 404 — the wrong answer to a malformed request.
//
// WHY THIS IS HERE NOW, HAVING DELIBERATELY NOT BEEN BEFORE. It lived as two
// identical copies, in work-unit-handler.ts and work-center-handler.ts, and the
// second one carried the rule for its own promotion:
//
//   "this is four lines with no policy in it, and the coupling a shared helper
//    would create between two modules that must not import each other's internals
//    costs more than the duplication saves. If a third appears, that is the moment
//    to move it."
//
// The SKU report is the third. Moving it now is that rule being kept rather than
// re-litigated — and the coupling it warned about does not materialise, because
// this module imports nothing from any feature module and none of them learns
// about the others by importing it.
//
// It stays FOUR LINES WITH NO POLICY IN IT. If a subject ever needs a different
// rule for what a valid id is — a composite key, a slug — it writes its own rather
// than growing a parameter here. A shared helper with a mode flag would be the
// coupling the original comment was right to refuse.
function requireReportId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "report id must be a positive integer" });
  }
  return id;
}

export { requireReportId };
