import { useTranslation } from "react-i18next";

import { formatDuration, formatQuantity } from "@/lib/format";
import { LossSection } from "@/components/report/loss-section";
import type { AnyReport } from "@/lib/report-subject";
import { QualityParetoCard } from "@/components/report/quality-pareto-card";

// THE WHOLE QUALITY LOSS TAB, and the second loss tab that is more than its
// Pareto — for a different reason than Performance Loss is.
//
//   Reject  -> oee.reject_count_wu_shift, one row per counter. Per-cause, so it
//              ranks: <QualityParetoCard />.
//   Rework  -> oee.work_unit_shift_reports.rework. ONE SCALAR, in the report's
//              own unit of measure. No table anywhere records WHY something was
//              reworked, so it cannot be ranked and does not pretend to be.
//
// That is structurally the shape Performance Loss took — one rankable half and one
// named total — and TODOS.md §24 predicted it. The difference is that Reduce Speed
// is a duration measured against a standard, while Rework is a COUNT of output
// that went back through the machine: it is not a share of the shift's clock and
// nothing here should imply it is.
//
// NO `view` PROP, unlike PerformanceLossTab. This tab has no sub-tabs, and the
// route's `view` search param stays inert here exactly as it does on Availability
// and Schedule Loss.
function QualityLossTab({ report }: { report: AnyReport }) {
  return (
    <div className="flex flex-col gap-4">
      <QualityParetoCard report={report} />
      <ReworkSection report={report} />
    </div>
  );
}

// The half that cannot be ranked, and the honest version of it.
//
// FROM THE REPORT, NOT FROM THE BREAKDOWN. `rework` is an ETL aggregate on the
// shift row and no counter in /rejects is a rework counter, so this figure has a
// different source from every number in the card above — which is precisely what
// the card's footnote warns the reader about.
//
// `uomName` rather than `uomCode`: the web-side ReportDetail carries only the
// name, and losses-card.tsx renders this same figure with the same field. Null
// leaks nothing — formatQuantity drops the unit rather than printing "null".
//
// CLOSED BY DEFAULT, unlike Reduce Speed. That band opens because its caveat is
// the only thing stopping the Small Stop ranking above it reading as the whole of
// Performance Loss. Nothing of the kind is at stake here: the header already
// states the figure, and the card above is titled "Quality Loss Pareto" and
// footnoted as being about rejects, so it cannot be read as including rework.
function ReworkSection({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  return (
    <LossSection
      label={t("report.rework")}
      // ONE UNIT PER SUBJECT, AND THREE DIFFERENT COLUMNS HOLD IT.
      //
      //   machine  `uomName`        one count point, one unit.
      //   line/SKU `infeedUomName`  TWO count points, and rework sits on the
      //                             INFEED side with total_out (0014). Passing the
      //                             output unit would label bags as cartons — the
      //                             trap line-losses-card.tsx states, and the
      //                             reason no shared component may read a unit.
      //   area     `weightUomName`  ONE unit again, and it is a MASS — an area's
      //                             members disagree about both sides, so mass is
      //                             the only unit they can all be expressed in
      //                             (0024). `infeedUomName` does not exist on that
      //                             payload at all, which is what made this a build
      //                             error rather than a mislabelled figure.
      value={formatQuantity(report.rework, reworkUnit(report))}
      valueClassName="text-oee-quality-fg font-semibold"
    >
      <div className="flex flex-col gap-2 px-4 py-4">
        <p className="text-sm">
          <span className="text-muted-foreground">{t("report.timeEquivalent")}</span>
          {/* The DURATION counterpart of the count on the header. Both are on the
              shift report and they answer different questions, which is why the
              Losses card renders Quality Loss as a duration and Reject and Rework
              as counts. */}
          <span className="text-oee-quality-fg font-medium tabular-nums">
            {formatDuration(report.reworkTime)}
          </span>
        </p>
        <p className="text-muted-foreground text-xs">{t("report.reworkNote")}</p>
      </div>
    </LossSection>
  );
}

// WHICH UNIT the rework figure is denominated in, read off the report's SUBJECT.
//
// A SWITCH WITH NO `default`, per reportSubject's instruction: a fifth subject must
// be a build error here rather than silently picking one of the four columns. That
// is precisely how the area subject surfaced — the ternary this replaced read
// `isMachineReport(report) ? uomName : infeedUomName`, which is "not a machine,
// therefore a line", the reading that breaks at three subjects and broke at four.
function reworkUnit(report: AnyReport): string | null {
  switch (report.subject) {
    case "machine":
      return report.uomName;
    case "line":
    case "sku":
      return report.infeedUomName;
    case "area":
      return report.weightUomName;
  }
}

export { QualityLossTab };
