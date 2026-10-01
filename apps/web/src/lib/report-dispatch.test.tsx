import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen, waitFor } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { lineReport, periodReport, shiftReport, skuReport } from "@/test/fixtures";
import { useReportDowntimeEvents, useReportRejects } from "@/lib/queries";

import type { AnyReport } from "@/lib/report-subject";
import type { ReactElement } from "react";

// WHICH QUERY DOES THIS HOOK HAND BACK?
//
// There are SEVEN report tables with seven INDEPENDENT identity sequences, so a
// report's id is meaningful only against the one table it came from. Every one of
// these endpoints answers with the same envelope and the same measures, so a test
// asserting "rows appeared" passes when the wrong subject's data is on screen.
//
// THE BUG THIS EXISTS FOR WAS REAL AND SILENT. Widening these hooks to a third
// subject left them type-correct and wrong: a SKU report has `grain === "day"`, so
// `line ? ... : isShift ? ... : periodQuery` fell through to the MACHINE PERIOD
// query. TypeScript cannot see it, because the shapes are compatible.
//
// ─────────────────────────────────────────────────────────────────────────────
//  WHY THIS ASSERTS THE RETURNED DATA AND *NOT* WHICH FETCHER WAS CALLED
// ─────────────────────────────────────────────────────────────────────────────
//
// The first version of this file mocked the four fetchers and asserted that only
// the right one ran. IT PASSED AGAINST THE BUG — verified by reintroducing it —
// and the reason is structural rather than incidental:
//
//   React forbids conditional hooks, so all four useQuery calls are CREATED on
//   every render and the unwanted three are gated with `enabled: false`. The SKU
//   query is enabled whenever the report is a SKU, so `getSkuRejects` fires
//   whether or not the hook RETURNS it. The dispatch bug is in the return
//   statement, which no spy on the fetchers can see.
//
// So each fetcher resolves a DISTINCT marker and the probe renders whatever the
// hook returned. That is the value the card would render, which is the thing that
// is actually wrong when this breaks.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportRejects: vi.fn(),
  getPeriodReportRejects: vi.fn(),
  getLineRejects: vi.fn(),
  getSkuRejects: vi.fn(),
  getShiftReportDowntimeEvents: vi.fn(),
  getPeriodReportDowntimeEvents: vi.fn(),
  getLineDowntimeEvents: vi.fn(),
  getSkuDowntimeEvents: vi.fn(),
}));

const api = await import("@/lib/api");

// RESOLVED VALUES SET PER TEST, not in the mock factory. A factory that calls
// `.mockResolvedValue()` sets the implementation once, and `vi.clearAllMocks()` in
// an afterEach — or any suite-level reset — leaves the spy returning `undefined`.
// A queryFn that returns undefined never settles, so every assertion below times
// out reporting `fetchStatus: "fetching"`, which reads exactly like a network
// problem and is not one. Observed while writing this file.
beforeEach(() => {
  vi.mocked(api.getShiftReportRejects).mockResolvedValue({ marker: "machine-shift" } as never);
  vi.mocked(api.getPeriodReportRejects).mockResolvedValue({ marker: "machine-period" } as never);
  vi.mocked(api.getLineRejects).mockResolvedValue({ marker: "line" } as never);
  vi.mocked(api.getSkuRejects).mockResolvedValue({ marker: "sku" } as never);
  vi.mocked(api.getShiftReportDowntimeEvents).mockResolvedValue({
    marker: "machine-shift",
  } as never);
  vi.mocked(api.getPeriodReportDowntimeEvents).mockResolvedValue({
    marker: "machine-period",
  } as never);
  vi.mocked(api.getLineDowntimeEvents).mockResolvedValue({ marker: "line" } as never);
  vi.mocked(api.getSkuDowntimeEvents).mockResolvedValue({ marker: "sku" } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// TWO PROBES, EACH CALLING ITS HOOK DIRECTLY, rather than one probe taking the
// hook as a prop. The prop version renders but its query never settles — the hook
// is invoked through a changing reference on every render, so TanStack sees a new
// observer each time and the resolved value never reaches a committed render.
// Verified both ways; the direct call resolves, the prop call sits on
// `fetchStatus: "fetching"` until the assertion times out, which reads like a
// network problem and is not one.
function RejectsProbe({ report }: { report: AnyReport }) {
  const result = useReportRejects(report) as { data?: { marker?: string } };
  return <span data-testid="marker">{result.data?.marker ?? "none"}</span>;
}

function EventsProbe({ report }: { report: AnyReport }) {
  const result = useReportDowntimeEvents(report) as { data?: { marker?: string } };
  return <span data-testid="marker">{result.data?.marker ?? "none"}</span>;
}

async function markerFor(ui: ReactElement) {
  renderWithQuery(ui);
  await waitFor(() => {
    expect(screen.getByTestId("marker").textContent).not.toBe("none");
  });
  return screen.getByTestId("marker").textContent;
}

const CASES = [
  ["machine shift", () => shiftReport({ id: 11 }), "machine-shift"],
  ["machine day", () => periodReport({ id: 22 }), "machine-period"],
  ["line", () => lineReport({ id: 33 }), "line"],
  ["sku", () => skuReport({ id: 44 }), "sku"],
] as const;

describe("useReportRejects returns the query for the report's own SUBJECT", () => {
  it.each(CASES)("%s", async (_label, make, expected) => {
    expect(await markerFor(<RejectsProbe report={make()} />)).toBe(expected);
  });
});

describe("useReportDowntimeEvents returns the query for the report's own SUBJECT", () => {
  it.each(CASES)("%s", async (_label, make, expected) => {
    expect(await markerFor(<EventsProbe report={make()} />)).toBe(expected);
  });
});

// The id is as load-bearing as the endpoint: the right function with another
// table's id returns a real report about something else.
describe("the dispatched call carries the report's OWN id", () => {
  it("passes a SKU report's id to the SKU endpoint", async () => {
    await markerFor(<RejectsProbe report={skuReport({ id: 44 })} />);

    expect(vi.mocked(api.getSkuRejects)).toHaveBeenCalledWith(44);
  });
});
