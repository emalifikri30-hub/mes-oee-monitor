import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { SixBigLossesCard } from "@/components/oee-dashboard/six-big-losses-card";

import type { DowntimeReasonBreakdown, RejectReasonBreakdown } from "@/lib/types";
import type { LossSources } from "@/lib/oee-dashboard/oee-performance";

// The ranking arithmetic is tested as a function in lib/oee-dashboard/. What this
// file exists for is the thing a pure function cannot reach: WHICH STATE THE CARD
// SELECTS — and in particular the two that would otherwise ship silently, a
// skeleton that never clears and a ranking computed over a missing source.

afterEach(cleanup);

const LOADED = "2026-08-31";

function downtime(
  buckets: { reason: string | null; durationMs: number }[],
  loadedThrough: string | null = LOADED,
): DowntimeReasonBreakdown {
  return {
    from: "",
    to: "",
    timeZone: "Asia/Jakarta",
    category: "UNPLANNED",
    buckets: buckets.map((b) => ({ ...b, workUnitNames: [], frequency: 1 })),
    other: null,
    totalFrequency: 0,
    totalDurationMs: 0,
    loadedThrough,
  } as DowntimeReasonBreakdown;
}

const REJECTS = {
  timeZone: "Asia/Jakarta",
  buckets: [
    {
      reason: "Total_NG_Prod",
      reasonCode: null,
      machineName: null,
      counterValue: 0,
      counterUnit: null,
      quantity: 0,
      convertedUnit: null,
      weightGram: null,
      frequency: 1,
      durationMs: 4_805_000,
    },
  ],
  totalFrequency: 0,
  totalDurationMs: 0,
  totalQuantity: 0,
  totalWeightGram: null,
  convertedUnit: null,
  loadedThrough: LOADED,
} as RejectReasonBreakdown;

const SOURCES: LossSources = {
  planned: downtime([{ reason: "Scheduled Maintenance", durationMs: 3_160_000 }]),
  unplanned: downtime([{ reason: "Unknown", durationMs: 20_181_000 }]),
  smallStop: downtime([{ reason: "Jam_Sensor", durationMs: 492_000 }]),
  rejects: REJECTS,
  reduceSpeedLossTime: 770_000,
};

const SETTLED = [
  { isPending: false, isError: false },
  { isPending: false, isError: false },
  { isPending: false, isError: false },
  { isPending: false, isError: false },
];

function setup(overrides: Partial<Parameters<typeof SixBigLossesCard>[0]> = {}) {
  return renderWithQuery(
    <SixBigLossesCard
      sources={SOURCES}
      states={SETTLED}
      reportPending={false}
      reportBusinessDay="2026-08-01"
      timeZone="Asia/Jakarta"
      subjectLabel="Machine"
      {...overrides}
    />,
  );
}

describe("SixBigLossesCard", () => {
  it("ranks every source longest-first, badged by where it came from", () => {
    setup();

    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("Total_NG_Prod")).toBeTruthy();
    expect(screen.getByText("Scheduled Maintenance")).toBeTruthy();
    expect(screen.getByText("Reduce Speed")).toBeTruthy();
    expect(screen.getAllByText("AL")).toHaveLength(1);
    expect(screen.getAllByText("QL")).toHaveLength(1);
    expect(screen.getAllByText("SL")).toHaveLength(1);
    // Small stop and the reduce-speed row are both Performance Loss.
    expect(screen.getAllByText("PL")).toHaveLength(2);
  });

  // THE TRAP lib/load-state.ts RECORDS, reached from the other side. The four
  // breakdown queries are gated until the report resolves, and a gated useQuery
  // reports `status: "pending"` FOREVER. A ladder that read their `isPending`
  // first would render a skeleton that never clears — on the screen's centrepiece.
  it("shows a skeleton while the REPORT is pending, not a never-clearing one", () => {
    const { container } = setup({
      reportPending: true,
      // Exactly the state a gated query is in, and it must not be consulted.
      states: SETTLED.map(() => ({ isPending: true, isError: false })),
    });

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("Unknown")).toBeNull();
  });

  it("clears the skeleton once the report and the sources have settled", () => {
    const { container } = setup();

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  // A top six ranked over three of four sources is WRONG, not partial: every loss
  // the failed source would have contributed is missing, so a smaller one is
  // silently promoted and the card reads exactly as if that were the truth.
  it("refuses to rank at all when ANY ONE source failed", () => {
    setup({ states: [...SETTLED.slice(1), { isPending: false, isError: true }] });

    expect(screen.queryByText("Unknown")).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  // The sources are loaded by different pipeline models. When they disagree the
  // ranking compares a PARTIAL month against a COMPLETE one, which floats the
  // fully-loaded source's losses up the list with nothing on screen to say why.
  it("notes the earliest coverage when the sources' watermarks disagree", () => {
    setup({
      sources: {
        ...SOURCES,
        unplanned: downtime([{ reason: "Unknown", durationMs: 1 }], "2026-08-20"),
      },
      reportBusinessDay: "2026-09-01",
    });

    expect(screen.getByText(/only loaded through 2026-08-20/i)).toBeTruthy();
    // The ranking is still shown — a partial answer LABELLED as partial beats no
    // answer at all.
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("shows no skew note when every source reaches the report's month", () => {
    setup();

    expect(screen.queryByText(/only loaded through/i)).toBeNull();
  });

  it("says so when nothing was recorded at all", () => {
    setup({
      sources: {
        planned: downtime([]),
        unplanned: downtime([]),
        smallStop: downtime([]),
        rejects: { ...REJECTS, buckets: [] },
        reduceSpeedLossTime: undefined,
      },
    });

    expect(screen.getByText(/No losses recorded/i)).toBeTruthy();
  });
});
