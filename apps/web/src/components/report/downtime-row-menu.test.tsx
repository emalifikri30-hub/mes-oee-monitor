import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { DowntimeRowMenu, REASON_COPY } from "@/components/report/downtime-row-menu";

// THREE STATES, AND THE DISABLED ONES HAVE TO EXPLAIN THEMSELVES.
//
// Everywhere else in this app, a disabled item means "nobody designed this" —
// report-actions.tsx states that rule. Edit is different: the feature works,
// and it is unavailable for a reason specific to THIS ROW. So each disabled case
// carries a tooltip naming which reason applies, and asserting the copy is how
// that stays true.
afterEach(cleanup);

// KEYBOARD, not click. happy-dom has no real PointerEvent, so fireEvent.click on
// the trigger leaves the menu closed and every query below fails with a confusing
// "unable to find role menuitem" — the note report-actions.test.tsx already
// carries for the same reason.
function open(props: Parameters<typeof DowntimeRowMenu>[0]) {
  renderWithQuery(<DowntimeRowMenu {...props} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Row actions" }), { key: "Enter" });
}

// By textContent rather than accessible name: a disabled item wrapped in a
// tooltip trigger does not always expose the name query reliably under happy-dom,
// and the text is what a reader sees either way.
function item(label: RegExp): HTMLElement {
  const found = screen.getAllByRole("menuitem").find((i) => label.test(i.textContent ?? ""));
  if (found === undefined) throw new Error(`no menu item matching ${String(label)}`);
  return found;
}

const editItem = () => item(/^edit$/i);

describe("DowntimeRowMenu", () => {
  it("offers Edit on an editable row", () => {
    const onEdit = vi.fn();
    open({ onViewDetail: vi.fn(), onEdit, unavailableReason: null });

    expect(editItem().getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(editItem());
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no-stable-id" as const, /no stable id yet/i],
    ["report-approved" as const, /has been approved/i],
  ])("disables Edit for %s and says why", (reason, expected) => {
    open({ onViewDetail: vi.fn(), onEdit: vi.fn(), unavailableReason: reason });

    expect(editItem().getAttribute("aria-disabled")).toBe("true");
    // The reason has to be REACHABLE, not merely present in a constant — a
    // tooltip bound to a pointer-events:none item never fires, which is why the
    // component wraps it in a span.
    expect(REASON_COPY[reason]).toMatch(expected);
    expect(editItem().getAttribute("aria-describedby")).toBe("downtime-edit-unavailable");
  });

  // The two reasons say different things and must not be interchangeable: one is
  // permanent until the pipeline acts, the other is something the reader can fix
  // right now.
  it("gives the two reasons different copy", () => {
    expect(REASON_COPY["no-stable-id"]).not.toBe(REASON_COPY["report-approved"]);
    expect(REASON_COPY["report-approved"]).toMatch(/reopen/i);
  });

  // Tables that do not offer editing at all pass no handler. The item still
  // renders — removing it would make the menu's shape depend on the table, and a
  // reader would not know the action exists.
  it("disables Edit when the table offers no handler", () => {
    open({ onViewDetail: vi.fn(), unavailableReason: null });

    expect(editItem().getAttribute("aria-disabled")).toBe("true");
  });

  it("always offers View detail", () => {
    const onViewDetail = vi.fn();
    open({ onViewDetail, onEdit: vi.fn(), unavailableReason: "no-stable-id" });

    fireEvent.click(item(/view detail/i));
    expect(onViewDetail).toHaveBeenCalledTimes(1);
  });
});
