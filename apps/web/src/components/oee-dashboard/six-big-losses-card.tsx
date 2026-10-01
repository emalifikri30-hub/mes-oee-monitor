import { AlertTriangleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buildSixBigLosses, lossWatermarkSkew, TOP_N } from "@/lib/oee-dashboard/oee-performance";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { LossBadge, LossSources, SixBigLoss } from "@/lib/oee-dashboard/oee-performance";

// The six largest losses on one month, ranked across every source that records
// one. See buildSixBigLosses for the merge and the proof that it is exact.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE FAILED SOURCE FAILS THE WHOLE CARD, and that is the decision to preserve
// ─────────────────────────────────────────────────────────────────────────────
//
// A top six ranked over four of five sources is not a partial answer — it is a
// WRONG one. Every loss the failed source would have contributed is missing, so a
// smaller loss is silently promoted into the list and the card reads exactly as it
// would if that were the truth. There is no visual difference between "these are
// the six biggest" and "these are the six biggest among the ones that loaded".
//
// So: any error, and the card says so. It never ranks what arrived.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOAD LADDER READS THE REPORT FIRST, AND MUST
// ─────────────────────────────────────────────────────────────────────────────
//
// The four breakdown queries are gated on `reasonBreakdownParams`, which returns
// undefined until the report has loaded. A gated useQuery reports
// `status: "pending"` FOREVER — lib/load-state.ts records this and it has shipped
// as a bug twice. Reading `isPending` on those queries before the report resolves
// therefore renders a skeleton that never clears, on the centrepiece of the
// screen. `reportPending` is checked first for that reason, and is not merely an
// ordering preference.
type LossQueryState = {
  isPending: boolean;
  isError: boolean;
};

// The badge colours come from the `-fg` ramp, never the band tokens. The bands are
// chart fills and fail WCAG contrast as text — losses-card-shell.tsx makes the same
// call for the same figures one screen over.
const BADGE_CLASS: Record<LossBadge, string> = {
  AL: "bg-oee-unplanned-downtime/15 text-oee-unplanned-downtime-fg",
  SL: "bg-oee-planned-downtime/15 text-oee-planned-downtime-fg",
  PL: "bg-oee-small-stop/15 text-oee-small-stop-fg",
  QL: "bg-oee-quality/15 text-oee-quality-fg",
};

function LossRow({ loss, rank }: { loss: SixBigLoss; rank: number }) {
  const { t } = useTranslation("oee");
  const badgeTitle = {
    AL: t("dashboard.badgeAL"),
    SL: t("dashboard.badgeSL"),
    PL: t("dashboard.badgePL"),
    QL: t("dashboard.badgeQL"),
  } as const;
  return (
    <li className="flex items-center gap-3 py-2">
      <span
        className={cn(
          "w-8 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold",
          BADGE_CLASS[loss.badge],
        )}
        title={badgeTitle[loss.badge]}
      >
        {loss.badge}
      </span>
      <span className="text-muted-foreground w-4 shrink-0 text-sm tabular-nums">{rank}.</span>
      {/* A reject counter's name is rendered VERBATIM — `Total_NG_Prod`, not
          "Total NG Prod". It is the one string a reader can match against the
          machine in front of them. */}
      <span className="min-w-0 flex-1 truncate text-sm">{loss.reason}</span>
      <span className="shrink-0 text-sm tabular-nums">{formatDuration(loss.durationMs)}</span>
    </li>
  );
}

function SixBigLossesCard({
  sources,
  states,
  reportPending,
  reportBusinessDay,
  timeZone,
  subjectLabel,
}: {
  sources: LossSources;
  // One per fetched source, in no particular order — only their aggregate matters.
  states: LossQueryState[];
  reportPending: boolean;
  reportBusinessDay: string | null | undefined;
  timeZone: string;
  subjectLabel: string;
}) {
  const { t } = useTranslation("oee");
  const losses = buildSixBigLosses(sources);

  const skew = lossWatermarkSkew(reportBusinessDay, timeZone, [
    sources.planned?.loadedThrough,
    sources.unplanned?.loadedThrough,
    sources.smallStop?.loadedThrough,
    sources.rejects?.loadedThrough,
  ]);

  const anyError = states.some((s) => s.isError);
  // Only meaningful once the report has resolved — before that these are gated
  // queries and pend forever. See the header.
  const anyPending = !reportPending && states.some((s) => s.isPending);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t("dashboard.sixBigLossesTitle")}
          <Tooltip>
            <TooltipTrigger aria-label={t("dashboard.sixBigLosses")}>
              <AlertTriangleIcon className="text-muted-foreground size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {t("dashboard.sixBigHint", { count: TOP_N })}
            </TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {reportPending || anyPending ? (
          <ul className="divide-border divide-y">
            {Array.from({ length: TOP_N }, (_, i) => (
              <li key={i} className="py-3">
                <Skeleton className="h-5 w-full" />
              </li>
            ))}
          </ul>
        ) : anyError ? (
          // NAMED AS A RANKING FAILURE, not as a missing card. A reader who sees
          // "could not load" beside five rows would assume the five are the top
          // five; this says why there is nothing to show instead.
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("dashboard.sixBigError")}
          </p>
        ) : losses.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("dashboard.sixBigEmpty", { subject: subjectLabel.toLowerCase() })}
          </p>
        ) : (
          <>
            {skew !== null && (
              // THE SOURCES DISAGREE ABOUT HOW MUCH OF THE MONTH THEY COVER, which
              // distorts the ranking rather than shortening it: a partial month of
              // downtime ranked against a complete month of rejects floats every
              // quality loss up the list. Without this the card is wrong and looks
              // right.
              <p className="text-muted-foreground mb-3 text-xs">
                {t("dashboard.sixBigSkew", { date: skew })}
              </p>
            )}
            <ul className="divide-border divide-y">
              {losses.map((loss, i) => (
                <LossRow key={`${loss.badge}-${loss.reason}`} loss={loss} rank={i + 1} />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export { SixBigLossesCard };
export type { LossQueryState };
