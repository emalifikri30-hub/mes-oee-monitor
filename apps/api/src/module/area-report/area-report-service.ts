import { HTTPException } from "hono/http-exception";

import { withLog, type Logger } from "@molca/utils";

import { getWatermark } from "../../shared/database/watermark.js";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type { GoldDB } from "../../shared/database/postgres.js";
import type { AreaReportReader } from "./area-report-repository.js";
import type { QualityEntry } from "../quality-entry/quality-entry.js";
import type { QualityEntryReader } from "../quality-entry/quality-entry-repository.js";
import type {
  AreaActivity,
  AreaCoarseGrain,
  AreaGrain,
  AreaActivityEntry,
  AreaActivitySource,
  AreaDowntimeEventBreakdown,
  AreaProductCounts,
  AreaProductionUnits,
  AreaRejectBreakdown,
  AreaReport,
  AreaWindow,
  ListAreaReportInput,
  PagedAreaReport,
} from "./area-report.js";

type AreaReportServiceDeps = {
  areaReportReaderRepository: AreaReportReader;
  // THE FEED's QUALITY ARM, across a module boundary through the Awilix seam the
  // work-unit, work-center and product-report services already use for exactly
  // this. The alternative is a copy of the ledger's query here, and a feed that
  // disagreed with the ledger it reports on would be worse than no feed.
  //
  // A READER. area-report-module.ts's "A READER AND NO WRITER" claim survives this
  // dependency intact, and that is the check on the whole arrangement: an area
  // report takes no operator mutation at all — there is no Add Reject on this
  // screen, by requirement — which is what 0024's write_audit triggers assert from
  // the database's side.
  qualityEntryRepository: QualityEntryReader;
  goldDb: GoldDB;
  logger: Logger;
};

// EVERY ID-ADDRESSED METHOD TAKES THE GRAIN FIRST, and it is not ceremony: the two
// area tables have INDEPENDENT identity sequences, so `getReport("day", 3)` and
// `getReport("month", 3)` are two different reports. Nine report tables across
// four subjects now, and the quiet failure is the dangerous one — a 404 if no row
// has that id, or another period's forty measures rendered without a warning if
// one does.
//
// GRAIN FIRST RATHER THAN LAST, matching work-unit's and work-center's coarse
// methods, so a call site reads `(grain, id)` on every subject in this service.
type TAreaReportService = {
  listReports: (input: ListAreaReportInput) => Promise<PagedAreaReport>;
  getReport: (grain: AreaCoarseGrain, reportId: number) => Promise<AreaReport>;
  getProductCounts: (grain: AreaGrain, reportId: number) => Promise<AreaProductCounts>;
  getProductionUnits: (grain: AreaGrain, reportId: number) => Promise<AreaProductionUnits>;
  getRejectReasons: (grain: AreaCoarseGrain, reportId: number) => Promise<AreaRejectBreakdown>;
  // Month only — a day has no days inside it to trend.
  getMonthOeeTrend: (reportId: number) => Promise<OeeTrend>;
  // Two named methods rather than one taking a grain — there is no day-grain
  // answer, so a grain argument would admit a call with no table behind it.
  getYearOeeTrend: (reportId: number) => Promise<OeeTrend>;
  getDowntimeEventReasons: (
    grain: AreaGrain,
    reportId: number,
  ) => Promise<AreaDowntimeEventBreakdown>;
  getActivity: (grain: AreaGrain, reportId: number) => Promise<AreaActivity>;
};

class AreaReportService implements TAreaReportService {
  private areaReportReaderRepository: AreaReportReader;
  private qualityEntryRepository: QualityEntryReader;
  private goldDb: GoldDB;
  private logger: Logger;

  constructor({
    areaReportReaderRepository,
    qualityEntryRepository,
    goldDb,
    logger,
  }: AreaReportServiceDeps) {
    this.areaReportReaderRepository = areaReportReaderRepository;
    this.qualityEntryRepository = qualityEntryRepository;
    this.goldDb = goldDb;
    this.logger = logger;
  }

  async listReports(input: ListAreaReportInput) {
    // The log event names the GRAIN, so the two lists are separable in a trace.
    // Interpolated rather than written twice for the reason work-center's service
    // does it: copies of one string differing by a word are where one of them comes
    // to name the wrong table.
    return await withLog(
      this.logger,
      `paged_area_${input.grain}_report`,
      input.filter,
      async () => {
        return await this.areaReportReaderRepository.paginateReport(input);
      },
    );
  }

  // 404 ON AN UNKNOWN ID, while the LIST answers 200-empty for an unknown filter.
  // The asymmetry is every subject's in this service: an id names a row that either
  // exists or does not, and a filter describes a set that may be empty. Answering
  // 200 here would make a broken deep link look like an area that produced nothing.
  async getReport(grain: AreaCoarseGrain, reportId: number) {
    return await withLog(this.logger, `detail_area_${grain}_report`, { reportId }, async () => {
      const found = await this.areaReportReaderRepository.getReport(grain, reportId);
      if (!found) throw new HTTPException(404, { message: "report not found" });
      return found;
    });
  }

  // The window every sub-resource reads, taken FROM THE REPORT ROW rather than
  // from the request.
  //
  // `areaId` COMES OUT OF THE ROW TOO, and that is what makes an area read
  // un-spoofable: the caller names a report id, and which area that is is the row's
  // business. An `?areaId=` on these routes would let a caller ask for area B's
  // rejects against area A's report and get a coherent-looking answer.
  //
  // THE GRAIN DECIDES ONE THING AND ONLY ONE: where `dateTo` lands. A day window
  // ends the next day; a month window ends on the first of the next month, which
  // `ck_amr_month_start` (0025) guarantees `businessDate` is the start of. That is
  // the whole of the difference between the two grains outside the report reads
  // themselves — which is why no read below takes a grain and `AreaWindow` carries
  // none.
  //
  // AND NO SHIFT AT EITHER GRAIN. Every source table this window is applied to is
  // shift-keyed, so the range widens over the shifts rather than narrowing to one.
  // A shift here would silently report a third of a day — or a hundredth of a
  // month.
  //
  // NO TIME-ZONE RESOLUTION AND THEREFORE NO UPSTREAM CALL. `time_zone` is NOT NULL
  // on both area tables (0024, 0025), so the zone the business day was cut in comes
  // off the row that named the day. That pairing is contract §22's rule and it is
  // what keeps a business day from ever being reconstructed with `::date`.
  private async resolveWindow(grain: AreaCoarseGrain, reportId: number): Promise<AreaWindow> {
    const report = await this.getReport(grain, reportId);

    // THE GRAIN STILL DECIDES EXACTLY ONE THING — the exclusive end — which is what
    // let the year grain reuse this whole read path unchanged. `addYear` handles
    // the leap year for `addMonth`'s reason: a fixed day count is wrong roughly one
    // year in four, and the failure is a Pareto quietly missing its last day.
    const dateTo =
      grain === "year"
        ? addYear(report.businessDate)
        : grain === "month"
          ? addMonth(report.businessDate)
          : addDay(report.businessDate);

    return {
      areaId: report.areaId,
      dateFrom: report.businessDate,
      dateTo,
      timeZone: report.timeZone,
    };
  }

  // SKU View's rows.
  //
  // TWO READS IN SEQUENCE AND NOT IN PARALLEL, which is the one place in this
  // service that costs a round trip and cannot avoid it: the second read's scope IS
  // the first read's result. oee.product_count_wc_day carries no `area_id` (0016),
  // so the area's lines have to be resolved first — see AreaLines for why they come
  // from the pipeline's own attribution rather than from a master-data roster.
  //
  // The watermark IS parallel with the pair, because it depends on neither.
  //
  // `loadedThrough` NAMES product_count_wc_day, NOT area_day_reports. Two different
  // loads: the card's rows come from the first and its heading from the second, and
  // quoting the report table's watermark here would vouch for a freshness this
  // card's own source does not have. That table ships EMPTY with no dev seed (0016,
  // deliberately), so in dev this is the `empty-stale` arm — which is exactly the
  // state the browser's loaded/stale ladder exists to be able to say.
  async getProductCounts(grain: AreaGrain, reportId: number): Promise<AreaProductCounts> {
    return await withLog(this.logger, `products_area_${grain}_report`, { reportId }, async () => {
      const window = await this.resolveWindow(grain, reportId);

      const [lines, loadedThrough] = await Promise.all([
        this.areaReportReaderRepository.listAreaLines(window),
        getWatermark(this.goldDb, "product_count_wc_day"),
      ]);

      const items = await this.areaReportReaderRepository.listProductCount(window, lines);

      return { items, timeZone: window.timeZone, loadedThrough };
    });
  }

  // The Input/Output Production KPI — production per unit, across the area's lines.
  //
  // `loadedThrough` NAMES work_center_day_reports, for the reason above: these
  // buckets are summed from the LINE reports, not from the area row, so the
  // freshness that matters is that table's.
  async getProductionUnits(grain: AreaGrain, reportId: number): Promise<AreaProductionUnits> {
    return await withLog(
      this.logger,
      `production_units_area_${grain}_report`,
      { reportId },
      async () => {
        const window = await this.resolveWindow(grain, reportId);

        const [aggregate, loadedThrough] = await Promise.all([
          this.areaReportReaderRepository.aggregateProductionUnits(window),
          getWatermark(this.goldDb, "work_center_day_reports"),
        ]);

        return { ...aggregate, timeZone: window.timeZone, loadedThrough };
      },
    );
  }

  // The month's daily OEE curve, behind the OEE Performance dashboard's trend
  // chart. NO METRIC INSTRUMENT — see the machine module's twin for why that
  // asymmetry is a decision rather than an oversight.
  //
  // `oee` IS NULLABLE ON THIS TABLE and the payload keeps the null. Here that has
  // 0024's own meaning, which is neither of the other two in this schema: not "the
  // members disagreed" and not "not known", but "could not be brought to a common
  // basis". An area that scored zero and an area whose day could not be composed
  // are different facts, and coalescing would merge them into the flattering one.
  async getMonthOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "area_month_oee_trend", { reportId }, async () => {
      // Resolves the window purely for its time zone and its 404 — the repository
      // reads the span off the month row itself.
      const window = await this.resolveWindow("month", reportId);

      const [items, loadedThrough] = await Promise.all([
        this.areaReportReaderRepository.listMonthOeeTrend(reportId),
        getWatermark(this.goldDb, "area_day_reports"),
      ]);

      return { items, timeZone: window.timeZone, loadedThrough };
    });
  }

  // THE YEAR'S MONTHLY CURVE, and the ONE difference from its month sibling is the
  // watermark: this plots MONTH rows, so `area_month_reports` is the freshness that
  // matters. Reporting the DAY table's would make a year curve that stops in June
  // claim to be current.
  //
  // `oee` IS NULLABLE HERE with 0024's own meaning — "could not be brought to a
  // common basis", neither "the members disagreed" nor "not known" — and the
  // payload keeps the null for the reason the month sibling states.
  async getYearOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "area_year_oee_trend", { reportId }, async () => {
      // Resolves the window purely for its time zone and its 404 — the repository
      // reads the span off the year row itself.
      const window = await this.resolveWindow("year", reportId);

      const [items, loadedThrough] = await Promise.all([
        this.areaReportReaderRepository.listYearOeeTrend(reportId),
        getWatermark(this.goldDb, "area_month_reports"),
      ]);

      return { items, timeZone: window.timeZone, loadedThrough };
    });
  }

  async getRejectReasons(grain: AreaCoarseGrain, reportId: number) {
    return await withLog(this.logger, `reject_area_${grain}`, { reportId }, async () => {
      const window = await this.resolveWindow(grain, reportId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.areaReportReaderRepository.aggregateRejectReasons(window),
        getWatermark(this.goldDb, "reject_count_wc_shift"),
      ]);

      return { ...aggregate, timeZone: window.timeZone, loadedThrough };
    });
  }

  // The Others tab.
  //
  // NO UNATTRIBUTED COUNT BESIDE IT, unlike the SKU version, and the difference is
  // the axis rather than an omission. A SKU read narrows by `product_id`, which is
  // OCCUPANCY OVER TIME: NULL means "not attributed" and nothing can derive the
  // answer, so the residual has to travel with the payload (0020). An area read
  // narrows by `area_id`, which is CONTAINMENT: the area IS derivable from the
  // work unit, so a NULL there is a missing LABEL rather than a missing fact, and
  // the fix is a backfill upstream. Shipping a residual would invite a reader to
  // treat denormalisation lag as an attribution problem.
  async getDowntimeEventReasons(grain: AreaGrain, reportId: number) {
    return await withLog(this.logger, `downtime_events_area_${grain}`, { reportId }, async () => {
      const window = await this.resolveWindow(grain, reportId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.areaReportReaderRepository.aggregateDowntimeEventReasons(window),
        getWatermark(this.goldDb, "downtime_log_events"),
      ]);

      return { ...aggregate, timeZone: window.timeZone, loadedThrough };
    });
  }

  // ---------------------------------------------------------------------------
  // The Log Activity panel
  // ---------------------------------------------------------------------------
  //
  // TWO ARMS, AND THE THIRD IS NAMED SO ITS ABSENCE CAN BE READ — the shape the SKU
  // feed established, for a related but distinct reason.
  //
  //   downtime   every recorded change to a stop in this area, on this day.
  //   quality    every reject and rework an operator entered against one of this
  //              area's lines, voided rows included.
  //   approval   cannot be reported here. oee.work_unit_shift_report_approval_events
  //              is keyed (work_unit_id, date, shift) and an area day has neither —
  //              but unlike the SKU case, this grain DOES have child records it
  //              could count, so the absence needs the stronger argument: AN AREA
  //              REPORT IS NOT APPROVABLE. There is nothing to sign at this grain
  //              and no cascade defined for it, so the transitions that exist
  //              belong to the machine and line screens that can act on them.
  //              Surfacing three shifts' worth of sign-offs across every machine in
  //              an area would be a chronology nobody can act on from the page they
  //              are reading. It appears in `sources` as `not-applicable` and can
  //              never appear in `entries` — AreaActivityEntry has no such arm to
  //              construct.
  //
  // THE QUALITY ARM FANS OUT OVER THE AREA'S LINES, ONE CALL PER LINE, and that is
  // a deliberate trade rather than an oversight.
  //
  // oee.work_center_quality_entries is keyed (work_center_id, business_date, shift)
  // and carries NO area_id, and `TargetKey` names one line. The two alternatives
  // were a widened TargetKey and a second scoping query in the quality-entry
  // repository; both would put a SECOND statement of "what the feed shows" beside
  // `listForTarget`, which that file's own comment says it exists to prevent
  // ("expressing it that way rather than the other way round is deliberate, because
  // it leaves exactly ONE statement"). Fanning out reuses that one statement
  // exactly.
  //
  // N IS THE AREA'S LINE COUNT — single digits to low tens — and the calls are
  // concurrent, so the cost is one round trip's latency and N small indexed reads.
  // If an area ever has enough lines for that to matter, the fix is an `area_id`
  // column on the entries table (a contract ask), not a second query here.
  async getActivity(grain: AreaGrain, reportId: number): Promise<AreaActivity> {
    return await withLog(this.logger, `activity_area_${grain}_report`, { reportId }, async () => {
      const window = await this.resolveWindow(grain, reportId);

      const [downtime, lines] = await Promise.all([
        this.areaReportReaderRepository.listDowntimeEdits(window),
        this.areaReportReaderRepository.listAreaLines(window),
      ]);

      // THE RANGE VARIANT, with no shift and every SKU. An area day spans three
      // shifts, and every entry is shift-keyed — so the feed widens over them
      // rather than narrowing to one, which is what `listActivity` (the line-shift
      // arm) does instead. `productId: null` means every SKU on the line: an area
      // feed reports what happened in the AREA, and an entry belongs in it
      // whichever product it named.
      const perLine = await Promise.all(
        lines.workCenterIds.map((workCenterId) =>
          this.qualityEntryRepository
            .listActivityForTarget({
              workCenterId,
              dateFrom: window.dateFrom,
              dateTo: window.dateTo,
              shift: null,
              productId: null,
            })
            // The line rides out with its entries. `QualityEntry` carries a
            // `workCenterId` of its own, but pairing it here is what makes the
            // mapper below unable to attribute an entry to the wrong line even if
            // that field were ever dropped from the row shape.
            .then((entries) => entries.map((entry) => ({ workCenterId, entry }))),
        ),
      );

      const quality = perLine.flat();

      const entries: AreaActivityEntry[] = [
        ...downtime.entries,
        ...quality.map(({ workCenterId, entry }) => toAreaQualityActivity(workCenterId, entry)),
      ];

      // SORTED ON `at` ALONE, leaving ties to sort stability. `id` is a PREFIXED
      // STRING here, so comparing two of them is lexicographic and would invert an
      // arm's own correct ordering for entries sharing an instant — the note all
      // three other feeds carry.
      //
      // IT MATTERS MORE HERE THAN ANYWHERE ELSE, because the quality arm arrives as
      // N per-line lists concatenated: without this sort the panel would read as
      // line 1's whole day, then line 2's, which looks like a chronology and is
      // not.
      entries.sort((a, b) => b.at.getTime() - a.at.getTime());

      const sources: AreaActivitySource[] = [
        {
          kind: "approval",
          tracked: false,
          untrackedReason: "not-applicable",
          totalMembers: 0,
          trackedMembers: 0,
        },
        {
          kind: "downtime",
          // ZERO MEMBERS IS NOT AN UNTRACKED ARM, following the SKU feed rather
          // than the line one. "These downtime records carry no stable identifier"
          // is a claim about records that do not exist. The line feed's older
          // behaviour is left alone there because changing it is a visible copy
          // change on a shipped screen; TODOS.md records the alignment.
          tracked: downtime.totalMembers === 0 || downtime.trackedMembers > 0,
          untrackedReason:
            downtime.totalMembers > 0 && downtime.trackedMembers === 0 ? "no-stable-id" : null,
          totalMembers: downtime.totalMembers,
          trackedMembers: downtime.trackedMembers,
        },
        {
          kind: "quality",
          // UNCONDITIONALLY TRACKED. This service owns the write (0017), so every
          // entry that exists carries a full trail and the two counts are equal by
          // construction. ZERO IS A REAL ANSWER — no reject was entered by hand in
          // this area — where `quality.length > 0` would report a quiet day as an
          // unimplemented feature.
          tracked: true,
          untrackedReason: null,
          totalMembers: quality.length,
          trackedMembers: quality.length,
        },
      ];

      return { timeZone: window.timeZone, entries, sources };
    });
  }
}

// A LEDGER ROW AS THE AREA FEED READS IT.
//
// A DELIBERATE THIRD COPY of the same mapper, rather than a shared one — the call
// product-report-service.ts made about the second, and its argument holds: what the
// feeds share is a WIRE SHAPE, not a type, and a shared mapper would need a shared
// return type, which would re-couple three modules' payloads to save one function.
//
// `workCenterId` IS CARRIED HERE AND IN NO OTHER FEED. An area day spans three
// shifts AND N lines, and a rework names no machine — so the shift alone leaves two
// lines' entries reading as one line's, and the machine alone (which a reject has
// and a rework does not) covers only half of them. Both ship.
function toAreaQualityActivity(workCenterId: number, entry: QualityEntry): AreaActivityEntry {
  return {
    kind: "quality",
    id: `quality:${String(entry.id)}`,
    at: new Date(entry.enteredAt),
    by: entry.enteredBy,
    byName: entry.enteredByName,
    shift: entry.shift,
    workCenterId,
    entryKind: entry.kind,
    productName: entry.productName,
    reasonName: entry.reasonName,
    enteredQty: entry.enteredQty,
    enteredUomCode: entry.enteredUomCode,
    targetQty: entry.targetQty,
    targetUomCode: entry.targetUomCode,
    unitCheck: entry.unitCheck,
    voidedAt: entry.voidedAt,
    voidedBy: entry.voidedBy,
    voidedByName: entry.voidedByName,
    voidReason: entry.voidReason,
  };
}

// CALENDAR ARITHMETIC IN JS, INSTANT ARITHMETIC IN POSTGRES — the split
// work-center-service.ts makes and product-report-service.ts repeats, kept. A
// business day is a label, so adding one to it is date arithmetic with no zone in
// it; anything that needs an INSTANT goes through AT TIME ZONE in SQL, where the
// offset is resolved for that date.
//
// `T00:00:00Z` and getUTCDate keep it in UTC end to end, so a machine running in a
// negative offset cannot roll the date backwards on the way through.
//
// A FOURTH COPY OF `addDay` AND A SECOND OF `addMonth`, and they stay that way.
// Three lines each with no policy in them, and the coupling a shared helper would
// create between four modules that must not import each other's internals costs
// more than the duplication saves — the rule shared/report-id.ts was promoted
// under, applied in the other direction. If either ever needs to know about a
// grain, that is the moment to move it.
function addDay(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// The exclusive end of a MONTH's business-date range, from its first day.
//
// `setUTCMonth` HANDLES THE LENGTHS AND THE YEAR BOUNDARY, which is the whole
// reason it is used rather than `+ 30 days`: a month is 28 to 31 days, and December
// rolls the year. `ck_amr_month_start` guarantees the input is the first of a
// month, so the result is always the first of the next one.
//
// AND IT SAYS NOTHING ABOUT HOW LONG THE MONTH *IS*. That question needs a zone —
// across a DST transition a calendar month is 743 or 745 real hours, not 744 — and
// it is answered in Postgres by `resolveReportWindow`, where AT TIME ZONE resolves
// each boundary's own offset. Getting that split backwards is the failure
// shared/shift-window.ts's header sets out; this function is on the calendar side
// of it, where there is no zone at all.
function addMonth(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString().slice(0, 10);
}

// The exclusive end of a YEAR's business-date range, from its first day.
//
// `setUTCFullYear` HANDLES THE LEAP YEAR, which is the reason it is used rather
// than `+ 365 days`: a year is 365 or 366 days. `ck_ayr_year_start` guarantees the
// input is January 1, so the result is always January 1 of the next year.
function addYear(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString().slice(0, 10);
}

export { AreaReportService };
export type { TAreaReportService };
