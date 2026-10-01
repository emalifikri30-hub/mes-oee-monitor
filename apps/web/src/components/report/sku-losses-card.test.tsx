import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithQuery } from "@/test/render";
import { skuReport } from "@/test/fixtures";
import { SkuLossesCard } from "@/components/report/sku-losses-card";

// WHAT THIS CARD IS ALLOWED TO CLAIM ABOUT A SKU. The six loss durations come from
// the shell, shared with the machine and line cards and tested there; everything
// asserted here is a place where a SKU differs and the difference is invisible on
// screen.
//
//   the unit         reject and rework sit on the INFEED side, with total_out, and
//                    the fixture makes the two units differ (BAG in, CTN out)
//                    precisely so a swap fails here.
//
//   the link's SUBJECT AND GRAIN. SEVEN report tables with seven independent
//                    serial sequences, and the machine and line losses route
//                    literals COMPILE on this page because the param name is the
//                    same. So the href is asserted three ways: the right one, and
//                    the absence of each wrong subject.
//
//   no View button   the requirement excludes an hourly chart from this screen, so
//                    there is no `hourly` slot and no dialog to open.
//
//   the ledger line  what has been entered by hand, NEVER added into the tile.
//                    line-losses-card.test.tsx pins the same invariant one subject
//                    over, and the two must not drift.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkuLossesCard — the counts' unit", () => {
  it("labels reject and rework with the INFEED unit, not the output unit", () => {
    renderWithQuery(
      <SkuLossesCard
        report={skuReport({
          infeedUomName: "BAG",
          outputUomName: "CARTON",
          reject: 120,
          rework: 45,
        })}
      />,
    );

    expect(screen.getByText(/120 BAG/)).toBeTruthy();
    expect(screen.getByText(/45 BAG/)).toBeTruthy();
    expect(screen.queryByText(/CARTON/)).toBeNull();
  });
});

describe("SkuLossesCard — the Losses detail link", () => {
  it("points at this SKU's own Losses page", () => {
    renderWithQuery(<SkuLossesCard report={skuReport({ id: 12 })} />);

    const link = screen.getByRole("link", { name: /losses detail page/i });

    expect(link.getAttribute("href")).toBe("/report/sku/by-day/12/losses");
  });

  // THE TWO WRONG SUBJECTS, ASSERTED SEPARATELY. Both literals compile here, and
  // either would open a real report about another subject with a populated header
  // and no warning. LINK_PATHS in test/render.tsx carries the SKU routes so this
  // assertion is about the href and not about an unresolved "/".
  it("never points at a machine or a line report", () => {
    renderWithQuery(<SkuLossesCard report={skuReport({ id: 12 })} />);

    const href = screen.getByRole("link", { name: /losses detail page/i }).getAttribute("href");

    expect(href).not.toContain("/machine/");
    expect(href).not.toContain("/line/");
  });
});

describe("SkuLossesCard — the hourly affordance", () => {
  // A FACT ABOUT THE SUBJECT, not about the layout, which is why the shell takes
  // `hourly` as a slot rather than a boolean. The requirement excludes an hourly
  // production chart from this screen.
  it("offers no View button at all", () => {
    renderWithQuery(<SkuLossesCard report={skuReport()} />);

    expect(screen.queryByRole("button", { name: /hourly production detail/i })).toBeNull();
  });
});

describe("SkuLossesCard — Add Reject and Add Rework", () => {
  it("offers both, enabled", () => {
    renderWithQuery(<SkuLossesCard report={skuReport()} />);

    for (const name of [/add reject/i, /add rework/i]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBeNull();
    }
  });

  // Mounted only while open, so the dialog's catalogue queries cost nothing on a
  // page view and its per-open requestId is genuinely per-open.
  it("mounts no dialog until one is pressed", () => {
    renderWithQuery(<SkuLossesCard report={skuReport()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SkuLossesCard — entries not yet in the figure", () => {
  // THE KEY IS THE SKU'S OWN, with no grain in it. It must never be
  // ["work-center-quality-entries", "day", id]: the LINE day report sharing that
  // id is a different row from a different sequence, and the second card to mount
  // would render the other's ledger under this one's tile.
  const seedSku = (totals: unknown[]) => [
    {
      queryKey: ["sku-day-report-quality-entries", 7, false],
      data: { items: [], totals, targetUomCode: "BAG" },
    },
  ];

  it("shows what has been entered by hand, in the line's infeed unit", () => {
    renderWithQuery(
      <SkuLossesCard report={skuReport({ id: 7, reject: 5000, infeedUomName: "BAG" })} />,
      {
        seed: seedSku([{ kind: "reject", uomCode: "BAG", qty: 140, entries: 2 }]),
      },
    );

    expect(screen.getByText(/\+140 BAG entered/)).toBeTruthy();
  });

  // THE ASSERTION THAT MATTERS, and it is line-losses-card.test.tsx's one subject
  // over: 5000 measured plus 140 entered renders as 5000 and a separate 140, never
  // 5140. Adding them would be a SECOND definition of the composed number,
  // disagreeing with the one the pipeline writes for as long as the DAG had not
  // run.
  it("does not add the entries into the tile", () => {
    renderWithQuery(
      <SkuLossesCard report={skuReport({ id: 7, reject: 5000, infeedUomName: "BAG" })} />,
      {
        seed: seedSku([{ kind: "reject", uomCode: "BAG", qty: 140, entries: 1 }]),
      },
    );

    // No thousands separators: format.ts sets `useGrouping: false`.
    expect(screen.getByText(/5000 BAG/)).toBeTruthy();
    expect(screen.queryByText(/5140/)).toBeNull();
  });

  // THE CROSS-SUBJECT ASSERTION THE GRAIN ASSERTIONS CANNOT MAKE. A SKU report and
  // a LINE day report can share an id, so seeding the line's key must change
  // nothing here. A key collision would otherwise render populated and plausible.
  it("does not read the LINE day report's ledger under the same id", () => {
    renderWithQuery(
      <SkuLossesCard report={skuReport({ id: 7, reject: 5000, infeedUomName: "BAG" })} />,
      {
        seed: [
          ...seedSku([]),
          {
            queryKey: ["work-center-quality-entries", "day", 7, false],
            data: {
              items: [],
              totals: [{ kind: "reject", uomCode: "BAG", qty: 999, entries: 3 }],
              targetUomCode: "BAG",
            },
          },
        ],
      },
    );

    expect(screen.queryByText(/\+999/)).toBeNull();
    expect(screen.queryByText(/entered/)).toBeNull();
  });

  it("keeps a rework entry off the reject tile", () => {
    renderWithQuery(<SkuLossesCard report={skuReport({ id: 7 })} />, {
      seed: seedSku([{ kind: "rework", uomCode: "BAG", qty: 45, entries: 1 }]),
    });

    expect(screen.getAllByText(/\+45 BAG entered/)).toHaveLength(1);
  });

  it("shows nothing when nothing has been entered", () => {
    renderWithQuery(<SkuLossesCard report={skuReport({ id: 7 })} />, {
      seed: seedSku([]),
    });

    expect(screen.queryByText(/entered/)).toBeNull();
  });
});
