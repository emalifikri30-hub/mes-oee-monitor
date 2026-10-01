import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { lineReport, periodReport, shiftReport } from "@/test/fixtures";
import { SkuViewCard } from "@/components/report/sku-view-card";

// This card had NO test until TODOS §14, and the gap and the defect were the same
// thing: it rendered "No product output recorded for this shift" for a machine
// that genuinely ran nothing AND for a business day the pipeline had not reached.
// Those are opposite claims, and nothing on screen or in the suite distinguished
// them — the flattering one always won.
//
// Mocks lib/api rather than lib/queries, for timeline-card.test.tsx's reason: the
// wiring is what breaks, and stubbing the hook would replace the code under test.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportProducts: vi.fn(),
  getPeriodReportProducts: vi.fn(),
  getLineProducts: vi.fn(),
}));

const { getShiftReportProducts, getPeriodReportProducts, getLineProducts } =
  await import("@/lib/api");
const mocked = vi.mocked(getShiftReportProducts);
const mockedPeriod = vi.mocked(getPeriodReportProducts);
const mockedLine = vi.mocked(getLineProducts);

// The report is on business day 2026-08-09 (test/fixtures.ts).
const LOADED = "2026-08-09";
const BEHIND = "2026-08-01";
// The LINE fixture sits on 2026-08-01 — which is BEHIND for the machine one and
// LOADED for this one. Two constants rather than one, because a shared "behind"
// that happens to equal a fixture's own day tests the opposite arm silently.
const LINE_BEHIND = "2026-07-31";

const ITEM = {
  productId: 4,
  productName: "Kacang Garuda 20g",
  productCode: "KG-20",
  totalOut: 1000,
  goodOut: 980,
  reject: 15,
  rework: 5,
  uomCode: "BAG",
  baseUomCode: "BAG",
};

// The name renders as "1. Kacang Garuda 20g" — the index and the name are separate
// text nodes, so an exact-string match finds nothing.
const NAMED = /Kacang Garuda 20g/;

function payload(over: Partial<{ items: unknown[]; loadedThrough: string | null }> = {}) {
  return {
    items: [ITEM],
    timeZone: "Asia/Jakarta",
    loadedThrough: LOADED,
    ...over,
  } as Awaited<ReturnType<typeof getShiftReportProducts>>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkuViewCard", () => {
  it("renders a SKU block for each product", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(await screen.findByText(NAMED)).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TODOS §14 — the two empty states, which are the same payload
  // ─────────────────────────────────────────────────────────────────────────────
  it("reports a genuinely idle machine when the pipeline has reached the shift", async () => {
    mocked.mockResolvedValue(payload({ items: [], loadedThrough: LOADED }));

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(await screen.findByText(/no product output recorded/i)).toBeTruthy();
    expect(screen.queryByText(/has not been loaded/i)).toBeNull();
  });

  it("refuses to call it idle when the pipeline has not reached the shift", async () => {
    mocked.mockResolvedValue(payload({ items: [], loadedThrough: BEHIND }));

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    // The distinction the whole change exists for: same empty list, opposite claim.
    expect(await screen.findByText(/has not been loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no product output recorded/i)).toBeNull();
  });

  // A missing watermark row means NEVER loaded, which must not read as
  // loaded-through-the-epoch.
  it("treats a never-loaded product table as stale", async () => {
    mocked.mockResolvedValue(payload({ items: [], loadedThrough: null }));

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(await screen.findByText(/has not been loaded/i)).toBeTruthy();
  });

  // The inverse guard: rows that exist must render whatever the watermark says.
  // Suppressing real production figures because a watermark lagged would be the
  // opposite failure, and a worse one.
  it("still renders rows that exist even behind the watermark", async () => {
    mocked.mockResolvedValue(payload({ loadedThrough: BEHIND }));

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(await screen.findByText(NAMED)).toBeTruthy();
    expect(screen.queryByText(/has not been loaded/i)).toBeNull();
  });

  it("keeps a failure inside the card", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(await screen.findByText(/could not load the sku summary/i)).toBeTruthy();
  });

  // The gated-query trap, guarded here even though this query is never gated: the
  // ladder reads `no-params` before `isPending`, and a card that dropped that rung
  // locally would diverge from the shared function silently.
  it("shows a skeleton while the request is in flight, not an empty state", () => {
    mocked.mockReturnValue(new Promise(() => {}));

    const { container } = renderWithQuery(<SkuViewCard report={shiftReport()} />);

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(screen.queryByText(/no product output recorded/i)).toBeNull();
    expect(screen.queryByText(/has not been loaded/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHICH ENDPOINT THIS CARD ASKS, per grain
// ---------------------------------------------------------------------------
//
// THIS SHIPPED WRONG. The card called the shift endpoint unconditionally, so a
// day report's id went to /work-units/shift-reports/:id/products. The three
// report tables have INDEPENDENT serial sequences, which makes that two bugs:
//
//   no shift report with that id  ->  404, an error card. Noticed.
//   one that happens to exist     ->  200, another machine's SKUs on another
//                                     date, with nothing on screen to say so.
//
// A test asserting only that the card renders rows would have passed throughout,
// because it did render rows — the wrong ones. What catches it is asserting WHICH
// function was called, so these check the call and not the output.
describe("SkuViewCard endpoint selection", () => {
  it("asks the shift endpoint for a shift report, and not the period one", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<SkuViewCard report={shiftReport({ id: 12 })} />);

    await screen.findByText(NAMED);
    expect(mocked).toHaveBeenCalledWith(12);
    expect(mockedPeriod).not.toHaveBeenCalled();
  });

  it.each(["day", "month"] as const)(
    "asks the %s endpoint for a %s report, and never the shift one",
    async (grain) => {
      mockedPeriod.mockResolvedValue(payload());

      renderWithQuery(
        <SkuViewCard
          report={periodReport({ grain, id: 12, approval: grain === "month" ? null : undefined })}
        />,
      );

      await screen.findByText(NAMED);
      expect(mockedPeriod).toHaveBeenCalledWith(grain, 12);
      // THE ASSERTION THAT MATTERS. Without it a card that calls both, or the wrong
      // one, still shows rows and still passes.
      expect(mocked).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// WHICH SUBJECT this card asks about — the second axis, added in part 2
// ---------------------------------------------------------------------------
//
// There are now SIX product-count addresses, not three: oee.product_count_wu_*
// for a machine and oee.product_count_wc_* for a line, with independent
// sequences on both sides.
//
// THE SUBJECT AXIS FAILS MORE QUIETLY THAN THE GRAIN ONE, and the reason is
// specific to this card and to right now. The line tables ship EMPTY — Airflow has
// not been asked to fill them yet (contract §17) — so a line report that wrongly
// reached /work-units/* would be the ONLY case that renders any numbers at all.
// The correct behaviour looks like the broken one, and the broken one looks like
// the working one. Nothing but "which function was called" separates them.
describe("SkuViewCard subject selection", () => {
  it.each([
    ["shift", lineReport({ id: 12 })],
    ["day", lineReport({ grain: "day", shift: null, id: 12 })],
    ["month", lineReport({ grain: "month", shift: null, id: 12 })],
  ])("asks the LINE endpoint for a line %s report", async (grain, report) => {
    mockedLine.mockResolvedValue(payload());

    renderWithQuery(<SkuViewCard report={report} />);

    await screen.findByText(NAMED);
    expect(mockedLine).toHaveBeenCalledWith(grain, 12);
    // Both machine endpoints, because either would render a plausible card.
    expect(mocked).not.toHaveBeenCalled();
    expect(mockedPeriod).not.toHaveBeenCalled();
  });

  // The mirror. A machine report must not reach the line tables either — that
  // direction is the quieter one to MISS in review, because it currently renders
  // an empty card rather than wrong numbers, and an empty SKU View on a machine
  // report reads as an idle shift.
  it("never asks the line endpoint for a machine report", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<SkuViewCard report={shiftReport({ id: 12 })} />);

    await screen.findByText(NAMED);
    expect(mockedLine).not.toHaveBeenCalled();
  });
});

// The two empty states again, at line grain, because the CLAIM each makes is
// different here. Until Airflow writes oee.product_count_wc_*, `empty-stale` is
// the true arm for every line report — and it is reached through a watermark on a
// DIFFERENT table from the machine one, so a line report keyed against the machine
// watermark would report `empty-loaded`: "no product output recorded", which is a
// statement nobody has the data to make.
describe("SkuViewCard at line grain — which empty", () => {
  it("says the rows have not been loaded when the line watermark is behind", async () => {
    mockedLine.mockResolvedValue(payload({ items: [], loadedThrough: LINE_BEHIND }));

    renderWithQuery(<SkuViewCard report={lineReport()} />);

    expect(await screen.findByText(/has not been loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no product output recorded/i)).toBeNull();
  });

  // Subject-neutral wording, asserted: the message used to end "an idle machine",
  // which names the wrong thing on this screen.
  it("does not call a line a machine", async () => {
    mockedLine.mockResolvedValue(payload({ items: [], loadedThrough: null }));

    renderWithQuery(<SkuViewCard report={lineReport()} />);

    const message = await screen.findByText(/has not been loaded/i);
    expect(message.textContent).not.toMatch(/machine/i);
  });
});
