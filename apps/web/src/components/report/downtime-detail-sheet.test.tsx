import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { downtimeItem } from "@/test/fixtures";
import { DowntimeDetailSheet } from "@/components/report/downtime-detail-sheet";

// The drawer is opened from TWO tables — the Downtime Details card on the shift
// report, and the Availability Loss detail page. Both project the same columns
// server-side so it can assume every field is present on either.
//
// THE FIELD LIST IS THE TEST. If one table's projection loses a column, the
// drawer renders a blank where the other shows data, and nothing on screen says
// which of the two is wrong. Asserting the labels here is what turns that into a
// failing test rather than a silent inconsistency.
const LABELS = [
  "Area Name",
  "Line Name",
  "Machine Name",
  "Downtime Category",
  "Reason",
  "Start Time",
  "End Time",
  "Duration",
  "Detail Reason",
  "Actions",
  "Input By",
  "Maintained By",
];

afterEach(cleanup);

describe("DowntimeDetailSheet", () => {
  it("renders every field the design names, whichever table opened it", () => {
    renderWithQuery(<DowntimeDetailSheet row={downtimeItem()} open onOpenChange={() => {}} />);

    for (const label of LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows an em dash for the fields the pipeline does not write yet", () => {
    // Every one of these is null on every row in the reporting database today.
    // They render rather than being hidden: a field the operator expects and
    // cannot see is a question, a blank one is an answer.
    renderWithQuery(<DowntimeDetailSheet row={downtimeItem()} open onOpenChange={() => {}} />);

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders the full record when the pipeline has written it", () => {
    renderWithQuery(
      <DowntimeDetailSheet
        row={downtimeItem({
          areaName: "FI-2",
          detailReason: "film habis di tengah batch",
          inputBy: "operator-1",
          maintainedBy: "Operator",
          actions: ["Ganti Film"],
          reason: ["Ganti Film", "Machine_Stop"],
        })}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("FI-2")).toBeTruthy();
    expect(screen.getByText("H2-4")).toBeTruthy();
    expect(screen.getByText("film habis di tengah batch")).toBeTruthy();
    expect(screen.getByText("operator-1")).toBeTruthy();
    // EVERY reason, not just the primary one the Pareto grouped on — this
    // drawer is the only place the rest of them are readable.
    expect(screen.getByText("Machine_Stop")).toBeTruthy();
  });

  // Null endAt is a normal state — the stop is still running. A blank would read
  // as missing data.
  it("renders an open stop's end time as an em dash rather than a blank", () => {
    renderWithQuery(
      <DowntimeDetailSheet
        row={downtimeItem({ endAt: null, durationMs: null })}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("End Time")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
