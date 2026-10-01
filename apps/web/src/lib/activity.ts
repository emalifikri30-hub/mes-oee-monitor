import type { ActivityKind, UntrackedReason } from "@/lib/types";

// Copy and rendering for the two audit-trail panels.
//
// Pure, and shared by activity-log-sheet.tsx and changes-history-sheet.tsx. The
// two panels keep their own JSX — their state ladders genuinely differ — but
// this is the part that would silently drift if it were written twice.

// `oldValue` / `newValue` come from a jsonb column, so a value can be a string,
// an array of them, or null. Rendered through one function rather than
// interpolated, or an array reaches the DOM as "[object Object]".
//
// An empty array and an empty string both render as a dash: both mean "nothing
// here", and showing "[]" would leak the storage format onto the screen.
//
// MOVED HERE from changes-history-sheet.tsx when the activity feed became a
// second caller. Its behaviour test moved with it.
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "string") return value === "" ? "—" : value;
  return JSON.stringify(value);
}

// Section heading for one arm of the feed.
//
// A TOTAL map keyed on the wire enum, so adding an ActivityKind server-side is a
// TYPE ERROR here rather than a blank heading in production.
const SOURCE_TITLE: Record<ActivityKind, string> = {
  approval: "Approvals",
  downtime: "Downtime edits",
  quality: "Quality and defects",
};

// WHY an arm can carry nothing, in the reader's words.
//
// Total for the same reason SOURCE_TITLE is. The distinction these three sentences
// draw is the whole point of the panel: "nothing was recorded" and "nothing COULD
// be recorded" are opposite claims, and only the second one is true today.
const NOT_TRACKED_BODY: Record<UntrackedReason, string> = {
  // Quality. Reject and rework are written by the pipeline and nothing in this
  // system edits them, so there is no change to record — not merely none yet.
  "no-source":
    "Reject and rework figures are produced by the data pipeline and cannot be edited here, so no change to them is recorded against this shift.",
  // Downtime. The stops exist and are editable in principle; they carry no stable
  // identifier a trail could hang from, so nothing about them could ever have
  // been recorded.
  "no-stable-id":
    "These downtime records carry no stable identifier yet, so no change to them can be recorded.",
  // The generic case: a write path that has not shipped.
  "not-implemented": "Nothing writes this trail yet, so no entry can appear here.",
  // THE ONLY ONE THAT IS NOT "NOT YET". The other three describe a trail that
  // could exist; this says the event itself cannot. A SKU day report covers one
  // line's whole day and has no shift to sign off — the approval events are keyed
  // (work_unit_id, date, shift) — so there is nothing to record, now or ever.
  "not-applicable":
    "A SKU report has no sign-off of its own; approvals are recorded per machine shift on the line, so none can appear against this SKU.",
};

// The label above one entry. Approvals and downtime edits are different kinds of
// event and get different vocabulary — an approval has no "field", and calling
// its status change one would name a column that does not exist.
// THREE KINDS NOW, and the third arm is why this is a switch rather than a
// ternary. It WAS a ternary — "approval, else downtime" — so a `quality` entry
// rendered as "Downtime · undefined": the wrong noun, and `field` read off a row
// that has no such column.
//
// The `never` in the default is what stops a fourth kind shipping the same way:
// adding one to LineActivityEntry without a label here becomes a build error
// rather than a plausible-looking line in an audit trail.
function entryLabel(
  entry:
    | { kind: "approval" }
    | { kind: "downtime"; field: string }
    | { kind: "quality"; entryKind: string },
): string {
  switch (entry.kind) {
    case "approval":
      return "Approved";
    case "downtime":
      return `Downtime · ${entry.field}`;
    case "quality":
      // The operator's own word for what they recorded, capitalised. Not
      // "Quality · reject": the feed sits beside a card labelled Reject and
      // Rework, and a third vocabulary for the same two things is a thing a
      // reader has to translate.
      return entry.entryKind === "rework" ? "Rework added" : "Reject added";
    default: {
      const unreachable: never = entry;
      return unreachable;
    }
  }
}

// Who to name on an entry, and it is deliberately not `entry.by`.
//
// `by` is the KEYCLOAK SUBJECT — a UUID, durable and unreadable. `byName` is the
// display label captured when the row was written. Both travel because they
// answer different questions, and rendering the wrong one puts
// "by 4f3c1a8e-…" in front of an operator, which is what shipped first.
//
// THE TWO ARMS DIFFER, and the asymmetry is in the schema rather than here:
//
//   approval  oee.work_unit_shift_report_approval_events has by_subject AND
//             by_name, so the name is available and preferred.
//   downtime  oee.downtime_report_history has only changed_by, a subject
//             (0007's header says so). There is no name column to prefer, so
//             this renders the subject until one exists — see TODOS.md §21's
//             remaining half, which is what will start writing that table.
//
// Falls back to the subject rather than to a dash: a UUID is poor, but "by —"
// on an audited action is worse.
//
// Mirrors the header badge's `closedByName ?? closedBy`, deliberately — the two
// must not disagree about who approved a report.
// Structurally typed rather than taking ActivityEntry, so the LINE feed's entries
// go through the same function. What it reads — `kind`, `by`, `byName` — is
// identical on both; what differs between them is the CONTEXT label (which shift,
// versus which machine), and that is the caller's business.
//   quality   oee.work_center_quality_entries has entered_by AND
//             entered_by_name (0017), so the name is available and preferred —
//             the same shape as an approval, for the same reason: this service
//             writes the row and has the token in hand.
function entryActor(
  entry:
    | { kind: "downtime"; by: string }
    | { kind: "approval"; by: string | null; byName: string | null }
    | { kind: "quality"; by: string; byName: string | null },
): string {
  if (entry.kind === "downtime") return entry.by;
  // A system transition has no person behind it. Naming that is more honest
  // than an empty "by".
  return entry.byName ?? entry.by ?? "the system";
}

export { entryActor, entryLabel, NOT_TRACKED_BODY, renderValue, SOURCE_TITLE };
