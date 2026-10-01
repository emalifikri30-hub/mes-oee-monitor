import type {
  YearReportDetail,
  AreaReportDetail,
  LineReportDetail,
  ReportDetail,
  SkuReportDetail,
} from "@/lib/types";

// WHICH SUBJECT A REPORT IS, and what day it covers — the two questions every
// component shared between the machine and Line screens ends up asking.
//
// One home for both, because both are answered from the report's SHAPE rather than
// from a flag, and a second copy of either is a second chance to answer differently.
// lib/queries.ts's `reportWindowParams` makes the same discrimination for the
// downtime params; this is that test, named, for the callers that need it without
// needing a window.

// EVERY REPORT THIS APP RENDERS, as one union. Adding a subject here is what makes
// every exhaustive switch over `report.subject` fail to build until it is handled —
// which is the only mechanism that scales, because there is no way to grep for
// "places that assumed there were two".
type AnyReport = ReportDetail | LineReportDetail | SkuReportDetail | AreaReportDetail;

// `AnyReport` PLUS THE THREE YEAR PAYLOADS, for the three functions that genuinely
// serve a year — `reportWindowParams`, `reasonBreakdownParams`, `actionBreakdownQuery`.
//
// A SEPARATE UNION RATHER THAN A WIDER `AnyReport`, and lib/types.ts's header on
// YearReportDetail carries the argument: `AnyReport` is what every exhaustive
// `switch (report.grain)` on the REPORT surface sees, and a year arm would force a
// dozen of them to answer for screens that will never exist. These three take a
// wider PARAMETER instead, which costs nothing — their own switch is on `subject`,
// and a year report carries one.
type WindowedReport = AnyReport | YearReportDetail;

// WHICH SUBJECT, read off the tag rather than sniffed from the shape.
//
// THIS REPLACED `!("workUnitId" in report)` ON 2026-09-02, AND THE OLD FORM WAS A
// LATENT BUG RATHER THAN MERELY INELEGANT. A line report has no `workUnitId`
// because migration 0014 gives oee.work_center_*_reports no such column — sound
// for TWO subjects, and silently wrong the moment there is a third. A SKU report
// has no `workUnitId` either, so it read as a LINE, and every shared card would
// have served line data on a SKU screen: type-checked, rendered, plausible, and
// wrong. Discrimination by ABSENCE cannot distinguish "is a line" from "is not a
// machine"; those stopped being the same question.
//
// `subject` is stamped in lib/api.ts, the one place that knows which endpoint
// answered — the argument getShiftReport already makes about `grain`.
//
// SWITCH ON THIS, WITH NO `default`. An exhaustive switch over the returned union
// makes a fourth subject a BUILD ERROR at every site that must care, which is the
// only mechanism that scales: there is no way to grep for "places that assumed
// there were two".
function reportSubject(report: AnyReport): "machine" | "line" | "sku" | "area" {
  return report.subject;
}

// THE MACHINE GUARD, and it is the one most former `!isLineReport(...)` call sites
// actually wanted. Those sites read "not a line", meaning "has a work unit, so it
// can show a machine filter / a machine name / a trendline". With a third subject
// "not a line" and "is a machine" part company, and only this one stays true —
// and with a FOURTH the gap is wider still: three of the four subjects are now not
// machines.
function isMachineReport(report: AnyReport): report is ReportDetail {
  return report.subject === "machine";
}

// THERE IS DELIBERATELY NO `isLineReport`. It existed until 2026-09-02 and every
// one of its callers was really asking "is it a MACHINE?", by negation — the
// reading that breaks at three subjects. Converting them to `isMachineReport` left
// it with no callers at all, so it went rather than sitting here inviting the same
// mistake back. If a genuinely line-only narrowing appears, write
// `report.subject === "line"` at the site, or add the guard back then.

// The business day a report covers, as 'YYYY-MM-DD', or null when it cannot be
// known.
//
// THREE DIFFERENT SOURCES, and the differences are the whole reason this exists:
//
//   line / SKU / area `businessDate`, NOT NULL. These tables have no `date` column
//                     at all (0014, 0023, 0024), so there is nothing to convert and
//                     no zone involved.
//   machine day/month `businessDate`, nullable — 0013 added it to already-populated
//                     tables and Airflow has not backfilled it (§46).
//   machine shift     `date`, which is the INSTANT THE SHIFT STARTED. The calendar
//                     day only falls out of it in the plant's zone, which is why
//                     the report carries `timeZone`.
//
// Returned as a bare day rather than an instant because every caller feeds it to
// `isLoadedThrough`, which compares business days as STRINGS. That function passes
// a bare 'YYYY-MM-DD' straight through (`BARE_DAY` in format.ts) and reduces an
// instant through the zone, so handing it either is safe — but handing it the
// machine shift report's raw `date` and calling that a business day is the bug
// TODOS §17 records as already shipped once.
function reportBusinessDay(report: AnyReport): string | null {
  // A SKU report and an AREA report have the same shape as a line one here: a real
  // business date, NOT NULL and zone-free, straight off the Gold row (0023, 0024).
  // Only a MACHINE report can reach the instant-through-a-zone branch below, and
  // only at shift grain.
  if (report.subject !== "machine") return report.businessDate;
  if (report.grain !== "shift") return report.businessDate;
  return report.date;
}

// THE LOSSES DRILL-DOWN'S TARGET, as a route literal per subject and grain.
//
// Six literals rather than a template string, because TanStack can only check a
// literal — and because the machine ones COMPILE on a line page (the param name is
// the same) and would open an unrelated report. Lives here rather than in
// losses-tabs.tsx so the tab components can name it without importing back from
// their own parent.
type LossesDetailTo =
  | "/report/machine/by-shift/$reportId/losses/detail"
  | "/report/machine/by-day/$reportId/losses/detail"
  | "/report/machine/by-monthly/$reportId/losses/detail"
  | "/report/line/by-shift/$reportId/losses/detail"
  | "/report/line/by-day/$reportId/losses/detail"
  | "/report/line/by-monthly/$reportId/losses/detail"
  | "/report/sku/by-day/$reportId/losses/detail"
  | "/report/area/by-day/$reportId/losses/detail"
  | "/report/area/by-monthly/$reportId/losses/detail";

// WHERE A REPORT LIVES, as one value: which of the four SUBJECTS, which of the
// three GRAINS, and the id. EIGHT tables, nine independent identity sequences.
//
// ONE VALUE RATHER THAN THREE PROPS, and that is the whole point. The edit dialog
// and useEditDowntime previously took `reportId` and `grain` as separate
// parameters, which is exactly the shape a caller gets half-right: a line report's
// id with the machine subject implied compiles, and the invalidation then clears
// the MACHINE report sharing that id — a stranger's activity feed refetched while
// the operator's own feed stays stale, showing the panel they just changed as
// unchanged. Derived in one place, from the report itself, so there is nothing to
// keep in step.
// A DISCRIMINATED UNION rather than a flat object with three independent unions,
// because three of the twelve combinations it would otherwise admit are not report
// addresses at all: there is no SKU shift report and no SKU month report
// (oee.product_report_wc_day is a day table with no siblings — the same fact the
// sidebar's SKU section states), and no area SHIFT report (the requirement is
// explicit that an area has two grains). Spelling that out costs three lines and
// makes an unreachable address unrepresentable.
//
// It does NOT, by itself, catch a mis-dispatched SKU address: `grain: "day"` is a
// legal machine grain too, so `{subject: "sku", grain: "day"}` still satisfies
// anything reading the grain alone. That is why every consumer switches on
// `subject` FIRST, with a `never` default — see useEditDowntime.
type ReportAddress =
  | { subject: "machine"; grain: "shift" | "day" | "month"; id: number }
  | { subject: "line"; grain: "shift" | "day" | "month"; id: number }
  | { subject: "sku"; grain: "day"; id: number }
  // DAY AND MONTH, AND NO SHIFT — which is the requirement's shape rather than the
  // schema's limit ("only have 2 type of report on the Area"). The day grain
  // shipped first with this arm narrowed to `"day"` and a note that the month
  // "joins this union when it lands rather than being admitted early"; it has
  // landed, and there is no third grain to admit later. An address for a report
  // that cannot be fetched is the shape a caller gets half-right.
  | { subject: "area"; grain: "day" | "month"; id: number };

// WHERE A QUALITY ENTRY CAN LAND, as a narrowing of the above.
//
// A MACHINE REPORT HAS NO QUALITY LEDGER, and this makes that a type fact rather
// than a convention. oee.work_center_quality_entries is keyed
// (work_center_id, business_date, shift) — 0017's comment is explicit that a
// machine is PROVENANCE ONLY there, "it does NOT move oee.work_unit_*_reports,
// and there is no join anywhere that lets it". So a machine address cannot be
// handed to the ledger's reads or its two writes, and neither can a bare
// (grain, id) pair, which is the shape those functions took before this existed
// and the shape a caller gets half-right.
type QualityAddress = Extract<ReportAddress, { subject: "line" | "sku" }>;

function reportAddress(report: AnyReport): ReportAddress {
  // The cast is the price of deriving a union member from two independently typed
  // fields; every field comes off the report unchanged, and the union above is
  // what any consumer sees. A per-subject switch here would compile to the same
  // thing with more ceremony.
  return {
    subject: reportSubject(report),
    grain: report.grain,
    id: report.id,
  } as ReportAddress;
}

// THE SAME DERIVATION, NARROWED, for the ledger's reads and writes.
//
// Its parameter is the two report shapes that HAVE a quality ledger, so a machine
// report is refused at the call site rather than at the endpoint — and the return
// type is QualityAddress, so no caller has to assert. Without this, every call
// site would carry a cast from ReportAddress, and a cast is exactly where the
// machine case would slip back in.
function qualityAddress(report: LineReportDetail | SkuReportDetail): QualityAddress {
  return report.subject === "sku"
    ? { subject: "sku", grain: "day", id: report.id }
    : { subject: "line", grain: report.grain, id: report.id };
}

export { isMachineReport, qualityAddress, reportAddress, reportBusinessDay, reportSubject };
export type { AnyReport, WindowedReport, LossesDetailTo, QualityAddress, ReportAddress };
