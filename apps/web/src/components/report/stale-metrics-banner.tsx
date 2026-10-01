import { TriangleAlertIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { UseQueryOptions } from "@tanstack/react-query";
import type { MetricsStaleness } from "@/lib/types";

// "Somebody changed a stop's category, and these cards have not caught up."
//
// WHY ONLY A CATEGORY EDIT PUTS THIS ON SCREEN. Three of the four editable fields
// — reason, actions, detail reason — are read LIVE out of the downtime table by
// the Pareto, the drill-down and the drawer, so editing them is already reflected
// everywhere and there is nothing to warn about. `category` moves time between
// schedule loss and availability loss, and THOSE totals are precomputed by the
// pipeline into the shift report row: the OEE tiles, the timeline strip and the
// waterfall keep showing the pre-edit split until it recomputes.
//
// WHAT THIS BANNER DELIBERATELY DOES NOT DO, and it is the whole design.
//
// It does not claim the numbers ARE stale, and it does not clear itself. The
// tempting version compares the edit's instant against
// `oee.etl_watermarks.last_run_at` and hides once the pipeline has run — and that
// is wrong in the FLATTERING direction, because that watermark is TABLE-grained:
// a run covering other days advances it past the edit without recomputing THIS
// report, and the banner would disappear while the tiles were still wrong. That
// is the silent-failure shape this codebase refuses everywhere else.
//
// Per-report confirmation is not knowable until the recalculation trigger exists.
// So this states a FACT — this changed at T — names exactly which cards are
// affected and which are not, and stays up. A banner that lingers is a nuisance;
// one that clears early is a lie.
//
// RENDERS NOTHING WHILE PENDING, deliberately not a skeleton. It sits above the
// report header, so a skeleton would push the whole page down and then let it
// snap back — and the query is prefetched WITHOUT being awaited precisely so the
// page does not wait on it.
//
// TAKES ITS QUERY OPTIONS, NOT A REPORT ID (TODOS §50). It used to call
// `useMetricsStaleness` itself, which pinned it to the machine SHIFT endpoint;
// there are now seven report addresses and the same banner belongs on five of them.
// The endpoint choice therefore stays at the call site, where a test can assert
// it — the same reason TimelineCard takes params and ConfirmWriteDialog takes a
// mutation.
//
// That matters more here than anywhere else on the page: three of those tables
// have INDEPENDENT id sequences, and the usual answer from this endpoint is
// `null`. So the wrong endpoint does not error — it silently fails to raise a
// banner that should have been raised, and nothing on screen is missing except
// the warning.
// Generic over the KEY, because each of the five addresses has its own — and that
// is the point rather than an inconvenience. `queryOptions()` brands the key into
// its type, so a single concrete key here would only accept one of them.
function StaleMetricsBanner<TKey extends readonly unknown[]>({
  options,
  timeZone,
}: {
  options: UseQueryOptions<MetricsStaleness, Error, MetricsStaleness, TKey>;
  timeZone: string;
}) {
  const { t } = useTranslation("oee");
  const { data } = useQuery(options);

  const editedAt = data?.categoryEditedAt ?? null;
  if (editedAt === null) return null;

  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>
        {t("report.staleTitle", { when: formatDateTime(editedAt, timeZone) })}
      </AlertTitle>
      <AlertDescription>
        {/* Naming both halves is the point. "Some numbers may be stale" would
            leave a supervisor unsure which figure to trust, and the reasons and
            Paretos are genuinely current. */}
        <span>{t("report.staleBody")}</span>
      </AlertDescription>
    </Alert>
  );
}

export { StaleMetricsBanner };
