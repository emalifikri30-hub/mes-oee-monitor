import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport, skuReport } from "@/test/fixtures";
import { reportWindowParams } from "@/lib/queries";
import { TimelineCard } from "@/components/report/timeline-card";

// The first component test in this app, and the target TODOS.md §16 named as the
// smallest one: three non-data states and a single dependency.
//
// It mocks lib/api rather than lib/queries deliberately. The bug worth catching
// here lives in the WIRING — reportWindowParams returning undefined, which
// gates the query off, which pins useQuery at `status: "pending"` forever — and
// stubbing the hook would replace exactly the code under test.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftTimeline: vi.fn(),
}));

const { getShiftTimeline } = await import("@/lib/api");
const mocked = vi.mocked(getShiftTimeline);

// The report under test is on business day 2026-08-09 (see test/fixtures.ts), so
// a watermark AT or AFTER that day means loaded and one BEFORE it means the
// pipeline has not reached this shift.
const LOADED = "2026-08-09";
const BEHIND = "2026-08-01";

const RUN_ALL_SHIFT = {
  kind: "RUN_TIME" as const,
  startAt: "2026-08-09T00:00:00.000Z",
  endAt: "2026-08-09T04:00:00.000Z",
  durationMs: 14_400_000,
};

const A_REAL_STOP = {
  kind: "UNPLANNED" as const,
  startAt: "2026-08-09T04:00:00.000Z",
  endAt: "2026-08-09T08:00:00.000Z",
  durationMs: 14_400_000,
};

// A shift with an actual stop in it. `ready` regardless of the watermark, because
// there is information on the strip either way.
const TIMELINE = {
  from: "2026-08-09T00:00:00.000Z",
  to: "2026-08-09T08:00:00.000Z",
  timeZone: "Asia/Jakarta",
  loadedThrough: LOADED,
  segments: [RUN_ALL_SHIFT, A_REAL_STOP],
};

// ALL RUN_TIME — which is what BOTH a genuinely clean shift and an unloaded one
// come back as, because RUN_TIME is never stored: it is the name for a gap between
// records. The watermark is the only thing that separates them, which is the whole
// of TODOS §8.
const NO_DOWNTIME = {
  ...TIMELINE,
  segments: [{ ...RUN_ALL_SHIFT, endAt: "2026-08-09T08:00:00.000Z", durationMs: 28_800_000 }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TimelineCard", () => {
  it("renders the strip once the timeline arrives", async () => {
    mocked.mockResolvedValue(TIMELINE);

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    // The legend is static, so wait on the strip itself — TimelineStrip labels it
    // "Shift timeline from HH:MM to HH:MM, N segments" on a role="img" wrapper.
    const strip = await screen.findByRole("img", { name: /shift timeline from/i });

    expect(strip.getAttribute("aria-label")).toContain("2 segments");
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "work-unit", scopeId: 42, date: "2026-08-09", shift: "1" }),
    );
  });

  it("keeps a timeline failure inside the card", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(await screen.findByText(/could not load the downtime timeline/i)).toBeTruthy();
  });

  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // A report whose `date` cannot be reduced to a business day makes
  // reportWindowParams return undefined, which sets `enabled: false`. A disabled
  // query never leaves `status: "pending"`, so the card used to render a skeleton
  // that resolved to nothing — no error, no message, no log, and indistinguishable
  // from a slow network. It must say what happened instead, and it must not ask.
  it("explains an unreadable date instead of loading forever", async () => {
    mocked.mockResolvedValue(TIMELINE);

    const { container } = renderWithQuery(
      <TimelineCard params={reportWindowParams(shiftReport({ date: "" }))} />,
    );

    expect(await screen.findByText(/date could not be read/i)).toBeTruthy();
    // The message alone is not the fix. The SKELETON has to be gone: rendering
    // both is the state this bug actually produced, and it still looks like a
    // card that is about to load.
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    // And nothing may be asked for — there is no business day to ask about.
    expect(mocked).not.toHaveBeenCalled();
  });

  it("renders the legend regardless of state, so the strip is readable", () => {
    mocked.mockResolvedValue(TIMELINE);

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(screen.getByText("availability loss (unplanned DT)")).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TODOS §8 — the one silent failure this feature shipped with
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // An all-RUN_TIME timeline is what a clean shift AND an unloaded shift both look
  // like. The card used to draw a full-width green band for both, so a shift that
  // was down for hours rendered as flawless: no error, no empty state, and nothing
  // a test could catch. These two cases are the same payload with a different
  // watermark, and they must render differently.
  it("draws the green band for a clean shift the pipeline has reached", async () => {
    mocked.mockResolvedValue({ ...NO_DOWNTIME, loadedThrough: LOADED });

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    // The strip IS the right answer here — the pipeline can vouch for the shift,
    // so a clean shift should look clean.
    expect(await screen.findByRole("img", { name: /shift timeline from/i })).toBeTruthy();
    expect(screen.queryByText(/has not reached it/i)).toBeNull();
  });

  it("refuses the green band when the pipeline has not reached the shift", async () => {
    mocked.mockResolvedValue({ ...NO_DOWNTIME, loadedThrough: BEHIND });

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(await screen.findByText(/has not reached it/i)).toBeTruthy();
    // THE MESSAGE ALONE IS NOT THE FIX — the strip has to be gone. Rendering both
    // would still show a full-width green band with a caption under it, which reads
    // as a clean shift with a footnote.
    expect(screen.queryByRole("img", { name: /shift timeline from/i })).toBeNull();
  });

  // A missing watermark row means the table has NEVER been loaded, which must read
  // as stale rather than as loaded-through-the-epoch.
  it("treats a never-loaded downtime table as stale", async () => {
    mocked.mockResolvedValue({ ...NO_DOWNTIME, loadedThrough: null });

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(await screen.findByText(/has not reached it/i)).toBeTruthy();
  });

  // The inverse guard: a shift with real stops must draw regardless of the
  // watermark. Withholding the strip whenever the watermark is behind would hide
  // downtime that demonstrably exists, which is the opposite failure.
  it("still draws a shift that has real stops, even behind the watermark", async () => {
    mocked.mockResolvedValue({ ...TIMELINE, loadedThrough: BEHIND });

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(await screen.findByRole("img", { name: /shift timeline from/i })).toBeTruthy();
    expect(screen.queryByText(/has not reached it/i)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-SKU residual — TODOS §65 step 3, which is §8's argument one axis over
// ─────────────────────────────────────────────────────────────────────────────
//
// A product-filtered read is `product_id = X`, FALSE for NULL rather than
// unknown-but-included, so every stop the pipeline has not attributed to a SKU is
// silently absent — and it has attributed none of them yet (migration 0020 added
// the columns; nothing writes them). The watermark cannot separate the two cases
// here, because the rows ARE loaded; they just carry no product. So the green band
// has to be withheld and the residual said out loud.
describe("TimelineCard — a product-filtered window", () => {
  it("narrows the request to the report's SKU", async () => {
    mocked.mockResolvedValue(TIMELINE);

    renderWithQuery(<TimelineCard params={reportWindowParams(skuReport({ productId: 7 }))} />);

    await screen.findByRole("img", { name: /shift timeline from/i });
    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ productId: 7 }));
  });

  // The residual is a bigger surprise beside bands that ARE drawn than beside an
  // empty track, so the sentence is unconditional whenever a product filter is on.
  it("says the window is not the line's whole day, even when it has bands", async () => {
    mocked.mockResolvedValue(TIMELINE);

    renderWithQuery(<TimelineCard params={reportWindowParams(skuReport())} />);

    await screen.findByRole("img", { name: /shift timeline from/i });
    expect(screen.getByText(/not the line's whole day/i)).toBeTruthy();
  });

  it("says nothing of the kind on a line report, which is the whole day", async () => {
    mocked.mockResolvedValue(TIMELINE);

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    await screen.findByRole("img", { name: /shift timeline from/i });
    expect(screen.queryByText(/not the line's whole day/i)).toBeNull();
  });

  // THE PAIR THAT MATTERS. Same payload, same watermark, and the only difference
  // is whether a product was named — a full-width green band is a true statement
  // about a line's day and a claim nobody can support about a SKU's.
  it("refuses the green band for a SKU with nothing attributed to it", async () => {
    mocked.mockResolvedValue({ ...NO_DOWNTIME, loadedThrough: "2026-08-19" });

    renderWithQuery(<TimelineCard params={reportWindowParams(skuReport())} />);

    expect(await screen.findByText(/not the same as none having happened/i)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /shift timeline from/i })).toBeNull();
  });

  it("still draws it for a line whose day the pipeline has reached", async () => {
    mocked.mockResolvedValue({ ...NO_DOWNTIME, loadedThrough: LOADED });

    renderWithQuery(<TimelineCard params={reportWindowParams(shiftReport())} />);

    expect(await screen.findByRole("img", { name: /shift timeline from/i })).toBeTruthy();
  });
});
