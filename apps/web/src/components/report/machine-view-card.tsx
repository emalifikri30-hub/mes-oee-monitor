import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronDownIcon, InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatDateTime, formatDuration, formatQuantity } from "@/lib/format";
import { useLineMachines } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { MetricTile } from "@/components/report/metric-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { LineMachineBreakdown, LineReportDetail } from "@/lib/types";

// WHICH MACHINE DRAGGED THE LINE DOWN — one collapsible row per machine that
// reported into this line report.
//
// THE ONE THING A READER MUST NOT CONCLUDE FROM THIS CARD is that these rows add
// up to the line. They do not, and the header tooltip says so. A line is MEASURED
// at its own count points, so `line <> sum(machines)` (migration 0014, commit
// 4fccce8) — the overview card above reports the line's own figures and this
// reports each machine's own. Adding the Total Output column here and comparing it
// to the tile above is arithmetic that will not reconcile, and the disagreement
// would be CORRECT. So the card is framed as a comparison BETWEEN machines rather
// than as a decomposition OF the line, and it renders no total row: a total is
// precisely the number nobody should read off this.
//
// THE PER-ROW ARROW IS THE SIX-SEQUENCES HAZARD IN ITS SHARPEST FORM. It opens
// that machine's own report at the SAME grain, and the id it interpolates is
// `machine.reportId` — the MACHINE report's id, which the endpoint returns for
// exactly this purpose. The line report's own id is the wrong number and it is
// right there in scope: there are seven report tables with seven independent `serial`
// sequences, so `/report/machine/by-shift/{lineReportId}` opens a real machine
// report, about a machine that may not be on this line, on a date that may not be
// this one — with a populated header, a populated OEE row, and nothing anywhere
// saying it is the wrong record. machine-view-card.test.tsx asserts the href
// carries the row's id and never the line's.
//
// NO EXPANSION STATE IS PERSISTED and none is lifted: which row is open is a
// reading gesture, not a filter, so it does not belong in the URL. All rows start
// collapsed — the mock shows the first one open, but a line can carry a dozen
// machines and opening one by default makes the page's height depend on the
// roster.
function MachineViewCard({ report }: { report: LineReportDetail }) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useLineMachines(report.grain, report.id);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex-wrap items-center gap-3 py-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t("report.machineView")}
          <Tooltip>
            <TooltipTrigger>
              <InfoIcon className="text-muted-foreground size-3.5" />
            </TooltipTrigger>
            <TooltipContent align="start" className="max-w-xs">
              {t("report.machineViewHint")}
            </TooltipContent>
          </Tooltip>
        </CardTitle>

        {/* THE WINDOW, from the ENVELOPE rather than from a row. Every machine on
            a line runs the same shift, so a per-row pair could differ and that
            would be a fact about nothing. Resolved server-side, which is what
            keeps SHIFT_WINDOWS out of the browser. */}
        {data !== undefined ? (
          <span className="col-start-2 row-start-1 justify-self-end rounded-md border px-2.5 py-1.5 text-xs">
            {formatDateTime(data.from, data.timeZone)} {EM_DASH}{" "}
            {formatDateTime(data.to, data.timeZone)}
          </span>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-2 pb-5">
        {isPending ? <MachineSkeleton /> : null}

        {/* Card-local, like the timeline and SKU View: the route starts this
            request without awaiting it, so a failure costs this card alone. */}
        {isError ? (
          <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
            {t("report.loadMachineBreakdown")}
          </div>
        ) : null}

        {/* NO STALE/LOADED LADDER HERE, unlike SKU View, and the difference is real
            rather than an omission: these rows come from the same
            oee.work_unit_*_reports the machine screens read, so if the line report
            above rendered at all the pipeline has reached this window. An empty
            list means no machine named this line — which is the same disagreement
            the Status tile abstains on, said in prose. */}
        {data !== undefined && data.machines.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("report.noMachineOnLine")}</p>
        ) : null}

        {data?.machines.map((machine, index) => (
          <MachineRow key={machine.reportId} machine={machine} index={index} grain={report.grain} />
        ))}
      </CardContent>
    </Card>
  );
}

// One route literal per grain, as a ternary — the same shape the Losses card uses,
// and for the same reason: TanStack can only check a literal, so a renamed route
// becomes a build failure rather than a 404 at runtime.
function machineReportTo(grain: LineReportDetail["grain"]) {
  return grain === "shift"
    ? "/report/machine/by-shift/$reportId"
    : grain === "day"
      ? "/report/machine/by-day/$reportId"
      : "/report/machine/by-monthly/$reportId";
}

function MachineRow({
  machine,
  index,
  grain,
}: {
  machine: LineMachineBreakdown;
  index: number;
  grain: LineReportDetail["grain"];
}) {
  const { t } = useTranslation("oee");
  const [open, setOpen] = useState(false);
  const name = machine.workUnitName ?? t("report.machineFallback", { id: machine.workUnitId });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* The trigger takes the NAME, so the whole label is the affordance rather
            than a 16px chevron. The arrow beside it is a separate control and must
            stay outside the trigger: nesting a link inside a button is invalid
            HTML and, in practice, swallows the navigation. */}
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-4 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
          <span className="truncate text-sm font-semibold">
            {index + 1}. {name}
          </span>
          {machine.workUnitCode !== null ? (
            <span className="text-muted-foreground shrink-0 text-xs">{machine.workUnitCode}</span>
          ) : null}
        </CollapsibleTrigger>

        {/* Collapsed-row summary: ONE figure, and the one the card is for. It stays
            visible when the row is open too — scanning down the column is the whole
            reason the rows are collapsed by default. */}
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("report.availabilityLoss")}{" "}
          <span className="text-oee-unplanned-downtime-fg font-semibold">
            {formatDuration(machine.availabilityLossTime)}
          </span>
        </span>

        {/* THE ROW'S OWN reportId, never the line's — see the header. */}
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
          <Link to={machineReportTo(grain)} params={{ reportId: String(machine.reportId) }}>
            <ArrowUpRightIcon />
            <span className="sr-only">{t("report.openMachineReport", { name })}</span>
          </Link>
        </Button>
      </div>

      <CollapsibleContent className="border-t px-3 py-4">
        {/* The four counts, all in the MACHINE's single unit. A work unit has one
            count point, which is exactly what a line does not — so unlike the line
            cards there is no infeed/output split to get wrong here. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <MetricTile
            label={t("report.totalOutput")}
            value={formatQuantity(machine.totalOut, machine.uomName)}
          />
          <MetricTile
            label={t("report.finishGood")}
            value={formatQuantity(machine.goodOut, machine.uomName)}
          />
          <MetricTile
            label={t("report.reject")}
            value={formatQuantity(machine.reject, machine.uomName)}
          />
          <MetricTile
            label={t("report.rework")}
            value={formatQuantity(machine.rework, machine.uomName)}
          />
        </div>

        {/* The same six durations the Losses card renders, in the same order and
            with the same colour tokens, because a reader moving between the two is
            reading the same decomposition at a different subject. Not extracted
            into a shared component: that card's THREE-GROUP layout is its argument
            (see losses-card-shell.tsx) and this is a flat six-up inside a row. */}
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile
            label={t("report.scheduleLoss")}
            value={formatDuration(machine.scheduleLossTime)}
            labelClassName="text-oee-planned-downtime-fg"
            valueClassName="text-oee-planned-downtime-fg"
          />
          <MetricTile
            label={t("report.availabilityLoss")}
            value={formatDuration(machine.availabilityLossTime)}
            labelClassName="text-oee-unplanned-downtime-fg"
            valueClassName="text-oee-unplanned-downtime-fg"
          />
          <MetricTile
            label={t("report.performanceLoss")}
            value={formatDuration(machine.performanceLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
          <MetricTile
            label={t("report.smallStop")}
            value={formatDuration(machine.msLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
          {/* Goes negative when the machine outran its standard rate. Real data,
              shown as-is — the same call the Losses card makes. */}
          <MetricTile
            label={t("report.reduceSpeed")}
            value={formatDuration(machine.reduceSpeedLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
          <MetricTile
            label={t("report.qualityLoss")}
            value={formatDuration(machine.qualityLossTime)}
            labelClassName="text-oee-quality-fg"
            valueClassName="text-oee-quality-fg"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Three collapsed rows, which is the shape that lands — not one expanded one. A
// skeleton the size of the loaded content is what stops the page jumping.
function MachineSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-11 w-full" />
      ))}
    </div>
  );
}

export { MachineViewCard };
