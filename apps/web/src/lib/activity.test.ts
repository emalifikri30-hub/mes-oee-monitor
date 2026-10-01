import { describe, expect, it } from "vite-plus/test";

import {
  entryActor,
  entryLabel,
  NOT_TRACKED_BODY,
  renderValue,
  SOURCE_TITLE,
} from "@/lib/activity";

import type { ActivityEntry, ActivityKind, UntrackedReason } from "@/lib/types";

describe("renderValue", () => {
  // The reason this function exists at all: `oldValue` / `newValue` come from a
  // jsonb column, and interpolating an array into JSX renders "[object Object]".
  // Moved here from changes-history-sheet.tsx when the activity feed became a
  // second caller; both panels now share one implementation.
  it("joins an array rather than stringifying it", () => {
    expect(renderValue(["Ganti Film", "Cleaning"])).toBe("Ganti Film, Cleaning");
  });

  it("renders every kind of nothing as one dash", () => {
    // null, an absent value, an empty array and an empty string all mean "there
    // was nothing here". Rendering "[]" or "" would leak the storage format.
    expect(renderValue(null)).toBe("—");
    expect(renderValue(undefined)).toBe("—");
    expect(renderValue([])).toBe("—");
    expect(renderValue("")).toBe("—");
  });

  it("passes a plain string through", () => {
    expect(renderValue("Mlipit")).toBe("Mlipit");
  });

  it("falls back to JSON for a shape it does not know", () => {
    // Not silently blank: an unexpected shape should be visible and reportable,
    // not indistinguishable from an empty field.
    expect(renderValue({ a: 1 })).toBe('{"a":1}');
  });

  it("keeps an empty string inside an array visible as a gap", () => {
    expect(renderValue(["", "Cleaning"])).toBe(", Cleaning");
  });
});

describe("copy maps", () => {
  // TOTAL over their wire enums, so adding a value server-side is a TYPE ERROR
  // here rather than a blank heading or an empty paragraph in production.
  it("names every activity kind", () => {
    const kinds: ActivityKind[] = ["approval", "downtime", "quality"];
    for (const kind of kinds) {
      expect(SOURCE_TITLE[kind].length).toBeGreaterThan(0);
    }
  });

  it("explains every untracked reason", () => {
    const reasons: UntrackedReason[] = [
      "no-source",
      "no-stable-id",
      "not-implemented",
      "not-applicable",
    ];
    for (const reason of reasons) {
      expect(NOT_TRACKED_BODY[reason].length).toBeGreaterThan(0);
    }
  });

  it("distinguishes 'cannot be recorded' from 'nothing was recorded'", () => {
    // The whole point of the panel. Quality can never carry a row; downtime
    // could, once the pipeline writes a stable id. The two sentences must not
    // collapse into one.
    expect(NOT_TRACKED_BODY["no-source"]).not.toBe(NOT_TRACKED_BODY["no-stable-id"]);
  });

  // `not-applicable` IS THE FOURTH, and it says something the other three do not:
  // they describe a trail that could exist and does not yet, where this one says
  // the EVENT cannot exist at this grain. It arrived with the SKU day feed's
  // approval arm, and reusing `no-source` — whose sentence is about reject and
  // rework figures — would have printed that under the word "Approvals".
  it("does not reuse another reason's sentence for 'not applicable'", () => {
    const others = [
      NOT_TRACKED_BODY["no-source"],
      NOT_TRACKED_BODY["no-stable-id"],
      NOT_TRACKED_BODY["not-implemented"],
    ];

    expect(others).not.toContain(NOT_TRACKED_BODY["not-applicable"]);
    // And it must speak about SIGN-OFF, not about a missing write path: the
    // distinction is the only reason the value exists.
    expect(NOT_TRACKED_BODY["not-applicable"]).toMatch(/sign-off|approval/i);
  });
});

describe("entryLabel", () => {
  it("gives an approval its own vocabulary", () => {
    // NOT `field: "status"` — that would name a column the report does not have.
    expect(entryLabel({ kind: "approval" })).toBe("Approved");
  });

  it("names the changed field for a downtime edit", () => {
    expect(entryLabel({ kind: "downtime", field: "actions" })).toBe("Downtime · actions");
  });
});

describe("entryActor", () => {
  const SUBJECT = "4f3c1a8e-2b71-4d0e-9c55-a1b2c3d4e5f6";

  function approval(overrides: Partial<Extract<ActivityEntry, { kind: "approval" }>> = {}) {
    return {
      kind: "approval",
      id: "approval:1",
      at: "2026-08-09T09:00:00.000Z",
      by: SUBJECT,
      byName: "dewi",
      fromStatus: "open",
      toStatus: "closed",
      source: "operator",
      shift: null,
      ...overrides,
    } satisfies ActivityEntry;
  }

  // The bug this function exists to prevent: `by` is the Keycloak SUBJECT, so
  // rendering it put "by 4f3c1a8e-…" in front of an operator who had just
  // approved a report.
  it("prefers the captured name over the subject", () => {
    expect(entryActor(approval())).toBe("dewi");
  });

  it("falls back to the subject rather than to nothing", () => {
    // A UUID is poor; "by —" on an audited action is worse.
    expect(entryActor(approval({ byName: null }))).toBe(SUBJECT);
  });

  it("names the system when nobody made the transition", () => {
    expect(entryActor(approval({ by: null, byName: null, source: "system" }))).toBe("the system");
  });

  it("renders the downtime arm's subject, because it has no name column", () => {
    // oee.downtime_report_history stores only changed_by. Not a bug here — the
    // schema has nowhere to put a name (0007), and TODOS.md §21's remaining half
    // is what will start writing that table.
    const entry: ActivityEntry = {
      kind: "downtime",
      id: "downtime:9",
      at: "2026-08-09T09:00:00.000Z",
      by: SUBJECT,
      sourceEventId: "evt-a",
      field: "actions",
      oldValue: null,
      newValue: ["x"],
    };
    expect(entryActor(entry)).toBe(SUBJECT);
  });
});
