import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";

import type { UseQueryOptions } from "@tanstack/react-query";
import type { MetricsStaleness } from "@/lib/types";
import {
  lineMetricsStalenessQueryOptions,
  metricsStalenessQueryOptions,
  periodMetricsStalenessQueryOptions,
} from "@/lib/queries";
import { StaleMetricsBanner } from "@/components/report/stale-metrics-banner";

// Mocked rather than left to the seeded cache alone. This query is NOT gated —
// unlike the activity feed, it fires on mount — so the pending-state test below
// would otherwise make a real request to :3000 and fill the run with connection
// errors that look like failures.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getMetricsStaleness: vi.fn(() => new Promise(() => {})),
}));

// THE STATE LADDER IS THE TEST, and the absent states matter more than the
// present one — this banner is on screen for a small minority of reports and
// wrong on any of them is worse than missing.
afterEach(cleanup);

const KEY = metricsStalenessQueryOptions(7).queryKey;

function render(seed?: { categoryEditedAt: string | null }) {
  renderWithQuery(
    <StaleMetricsBanner options={metricsStalenessQueryOptions(7)} timeZone="Asia/Jakarta" />,
    {
      seed: seed === undefined ? [] : [{ queryKey: KEY, data: seed }],
    },
  );
}

describe("StaleMetricsBanner", () => {
  // NOT a skeleton, deliberately. It sits above the report header and is fed by a
  // prefetch the route does not await — a placeholder would push the whole page
  // down and let it snap back when the request lands.
  it("renders nothing while the query is pending", () => {
    render();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The state of every report today: nothing has written the history table yet.
  it("renders nothing when no category has been edited", () => {
    render({ categoryEditedAt: null });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the instant, in the plant's zone", () => {
    render({ categoryEditedAt: "2026-08-09T09:30:00.000Z" });

    // 09:30Z is 16:30 at UTC+7. Rendering it in UTC would put a supervisor's own
    // shift an hour or seven out.
    expect(screen.getByText(/09\/08\/2026 16:30/)).toBeTruthy();
  });

  // NAMING BOTH HALVES IS THE POINT. "Some numbers may be stale" would leave a
  // supervisor unsure which figure to trust, and the reasons and Paretos are
  // genuinely current — only the precomputed totals are not.
  it("says which cards are current and which are not", () => {
    render({ categoryEditedAt: "2026-08-09T09:30:00.000Z" });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/reasons, actions and the loss Paretos are up to date/i);
    expect(alert.textContent).toMatch(
      /OEE, A, P and Q tiles, the timeline strip and the waterfall/i,
    );
  });

  // IT MAKES NO CLAIM ABOUT THE PIPELINE, which is the design decision this
  // assertion pins. The tempting version compares the edit against
  // etl_watermarks.last_run_at and clears once the pipeline has run — and that is
  // wrong in the flattering direction, because the watermark is table-grained: a
  // run covering other days would advance it past the edit without recomputing
  // THIS report, and the banner would vanish while the tiles were still wrong.
  it("does not claim the numbers are stale, only that a change was made", () => {
    render({ categoryEditedAt: "2026-08-09T09:30:00.000Z" });

    const alert = screen.getByRole("alert");
    // Hedged about the pipeline, definite about the edit.
    expect(alert.textContent).toMatch(/A downtime category was changed/i);
    expect(alert.textContent).not.toMatch(/stale/i);
  });
});

// WHICH ENDPOINT EACH SCREEN'S BANNER READS (TODOS §50).
//
// The banner takes its query options rather than a report id precisely so this is
// assertable, and it is the assertion that matters most on this surface: three of
// the seven report tables have INDEPENDENT id sequences, and the usual answer from
// this endpoint is `null`. So the wrong endpoint does not error — it silently
// fails to raise a warning that should have been raised, and the only symptom is
// an absent banner nobody notices.
describe("StaleMetricsBanner — one key per report address", () => {
  const AT = { categoryEditedAt: "2026-08-09T10:00:00.000Z" };

  // A GENERIC HELPER rather than `it.each`: `queryOptions()` brands its key into
  // the type, so an array of four of them unions to something the component's
  // generic cannot infer. One call per address keeps each inference local.
  function rendersFrom<TKey extends readonly unknown[]>(
    options: UseQueryOptions<MetricsStaleness, Error, MetricsStaleness, TKey> & {
      queryKey: TKey;
    },
  ) {
    renderWithQuery(<StaleMetricsBanner options={options} timeZone="Asia/Jakarta" />, {
      seed: [{ queryKey: options.queryKey, data: AT }],
    });

    expect(screen.getByText(/A downtime category was changed/)).toBeTruthy();
  }

  it("renders from the machine shift entry", () => {
    rendersFrom(metricsStalenessQueryOptions(7));
  });

  it("renders from the machine day entry", () => {
    rendersFrom(periodMetricsStalenessQueryOptions("day", 7));
  });

  it("renders from the machine month entry", () => {
    rendersFrom(periodMetricsStalenessQueryOptions("month", 7));
  });

  it("renders from the line shift entry", () => {
    rendersFrom(lineMetricsStalenessQueryOptions(7));
  });

  // FOUR DISTINCT KEYS for the same id. A shared key would let a day screen render
  // the shift report 7's answer.
  it("keys the four addresses apart for the same report id", () => {
    const keys = [
      metricsStalenessQueryOptions(7).queryKey,
      periodMetricsStalenessQueryOptions("day", 7).queryKey,
      periodMetricsStalenessQueryOptions("month", 7).queryKey,
      lineMetricsStalenessQueryOptions(7).queryKey,
    ].map((key) => JSON.stringify(key));

    expect(new Set(keys).size).toBe(4);
  });

  // Seeded under the MACHINE SHIFT key, rendered with the LINE options: the banner
  // must find nothing rather than another report's answer.
  it("does not read another address's entry", () => {
    renderWithQuery(
      <StaleMetricsBanner options={lineMetricsStalenessQueryOptions(7)} timeZone="Asia/Jakarta" />,
      { seed: [{ queryKey: metricsStalenessQueryOptions(7).queryKey, data: AT }] },
    );

    expect(screen.queryByText(/A downtime category was changed/)).toBeNull();
  });
});
