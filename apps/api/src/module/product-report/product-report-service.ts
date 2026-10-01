import { HTTPException } from "hono/http-exception";

import { withLog, type Logger } from "@molca/utils";

import { getWatermark } from "../../shared/database/watermark.js";
import { resolveReportWindow } from "../../shared/shift-window.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { ProductReportReader } from "./product-report-repository.js";
import type { QualityEntry } from "../quality-entry/quality-entry.js";
import type { QualityEntryReader } from "../quality-entry/quality-entry-repository.js";
import type {
  ListProductReportInput,
  PagedProductReport,
  ProductActivity,
  ProductActivityEntry,
  ProductActivitySource,
  ProductDowntimeEventBreakdown,
  ProductMachineRoster,
  ProductRejectBreakdown,
  ProductReport,
  ProductWindow,
} from "./product-report.js";

type ProductReportServiceDeps = {
  productReportReaderRepository: ProductReportReader;
  // THE FEED's QUALITY ARM, across a module boundary through the Awilix seam the
  // work-unit and work-center services already use for exactly this. The
  // alternative is a copy of the ledger's query here, and a feed that disagreed
  // with the ledger it reports on would be worse than no feed.
  //
  // A READER. product-report-module.ts's "A READER AND NO WRITER" claim survives
  // this dependency intact, and that is the check on the whole arrangement: the
  // SKU screen's one operator write goes through the quality-entry module, and
  // oee.product_report_wc_day still takes no operator mutation — which is what
  // 0023's write_audit triggers assert from the database's side.
  qualityEntryRepository: QualityEntryReader;
  goldDb: GoldDB;
  logger: Logger;
};

type TProductReportService = {
  listReports: (input: ListProductReportInput) => Promise<PagedProductReport>;
  getReport: (reportId: number) => Promise<ProductReport>;
  getRejectReasons: (reportId: number) => Promise<ProductRejectBreakdown>;
  getDowntimeEventReasons: (reportId: number) => Promise<ProductDowntimeEventBreakdown>;
  getActivity: (reportId: number) => Promise<ProductActivity>;
  getMachines: (reportId: number) => Promise<ProductMachineRoster>;
};

class ProductReportService implements TProductReportService {
  private productReportReaderRepository: ProductReportReader;
  private qualityEntryRepository: QualityEntryReader;
  private goldDb: GoldDB;
  private logger: Logger;

  constructor({
    productReportReaderRepository,
    qualityEntryRepository,
    goldDb,
    logger,
  }: ProductReportServiceDeps) {
    this.productReportReaderRepository = productReportReaderRepository;
    this.qualityEntryRepository = qualityEntryRepository;
    this.goldDb = goldDb;
    this.logger = logger;
  }

  async listReports(input: ListProductReportInput) {
    return await withLog(this.logger, "paged_product_day_report", input.filter, async () => {
      return await this.productReportReaderRepository.paginateReport(input);
    });
  }

  // 404 ON AN UNKNOWN ID, while the LIST answers 200-empty for an unknown filter.
  // The asymmetry is the same one the line module documents: an id names a row
  // that either exists or does not, and a filter describes a set that may be
  // empty. Answering 200 here would make a broken deep link look like a SKU that
  // produced nothing.
  async getReport(reportId: number) {
    return await withLog(this.logger, "detail_product_day_report", { reportId }, async () => {
      const found = await this.productReportReaderRepository.getReport(reportId);
      if (!found) throw new HTTPException(404, { message: "report not found" });
      return found;
    });
  }

  // The window every sub-resource reads, taken FROM THE REPORT ROW rather than
  // from the request.
  //
  // `productId` COMES OUT OF THE ROW TOO, and that is what makes a SKU read
  // un-spoofable: the caller names a report id, and which SKU that is is the
  // row's business. A `?productId=` on these routes would let a caller ask for
  // SKU B's rejects against SKU A's report and get a coherent-looking answer.
  //
  // DAY GRAIN, SO THE END IS ALWAYS THE NEXT DAY. The line module branches on
  // grain here (a month adds a month); there is one grain to serve.
  private async resolveWindow(reportId: number): Promise<ProductWindow> {
    const report = await this.getReport(reportId);

    return {
      workCenterId: report.workCenterId,
      dateFrom: report.businessDate,
      dateTo: addDay(report.businessDate),
      // NULL, not a shift number. A SKU day report spans all three shifts, and the
      // source tables are shift-keyed — so this widens over them rather than
      // narrowing to one. Passing a shift here would silently report a third of
      // the day.
      shift: null,
      timeZone: report.timeZone,
      productId: report.productId,
    };
  }

  async getRejectReasons(reportId: number) {
    return await withLog(this.logger, "reject_product_day", { reportId }, async () => {
      const window = await this.resolveWindow(reportId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.productReportReaderRepository.aggregateRejectReasons(window),
        getWatermark(this.goldDb, "reject_count_wc_shift"),
      ]);

      return { ...aggregate, timeZone: window.timeZone, loadedThrough };
    });
  }

  // THE UNATTRIBUTED COUNT RIDES WITH THIS ANSWER, concurrently, and is not
  // optional. Without it a SKU whose stops are all unattributed is indistinguishable
  // from a SKU that never stopped — see UnattributedDowntime for why that is the
  // live state until the pipeline writes downtime_reports.product_id.
  async getDowntimeEventReasons(reportId: number) {
    return await withLog(this.logger, "downtime_events_product_day", { reportId }, async () => {
      const window = await this.resolveWindow(reportId);

      const [aggregate, unattributed, loadedThrough] = await Promise.all([
        this.productReportReaderRepository.aggregateDowntimeEventReasons(window),
        this.productReportReaderRepository.countUnattributedDowntime(window),
        getWatermark(this.goldDb, "downtime_log_events"),
      ]);

      return { ...aggregate, ...unattributed, timeZone: window.timeZone, loadedThrough };
    });
  }

  // ---------------------------------------------------------------------------
  // The Log Activity panel
  // ---------------------------------------------------------------------------
  //
  // TWO ARMS, AND THE THIRD IS NAMED SO ITS ABSENCE CAN BE READ.
  //
  //   downtime   every recorded change to a stop THIS SKU owns.
  //   quality    every reject and rework an operator entered against this SKU on
  //              this line and day, voided rows included.
  //   approval   cannot exist. oee.work_unit_shift_report_approval_events is keyed
  //              (work_unit_id, date, shift) and this grain has neither, so there
  //              is nothing to sign and no event to report. It appears in
  //              `sources` as `not-applicable` and can never appear in `entries` —
  //              ProductActivityEntry has no such arm to construct.
  //
  // TODOS.md §65 left "decide what a SKU feed contains before building one" open.
  // This is that decision.
  //
  // WHY NOT SIMPLY OMIT THE APPROVAL SOURCE. The panel exists to separate "nothing
  // was recorded" from "nothing COULD be recorded", and a reader who knows the six
  // other report screens carry approvals will look for them here. Saying so costs
  // one row and answers the question; leaving it out makes the reader guess, and
  // the guess "the feature is half-built" is the wrong one.
  //
  // THE RESIDUAL TRAVELS WITH IT, from the same countUnattributedDowntime that
  // backs /downtime-events. The downtime arm is narrowed by product, and
  // `product_id = $` is FALSE for NULL rather than unknown-but-included — so with
  // 0020's column unwritten this arm reports nothing for a SKU that certainly
  // stopped. An empty panel would then mean either "nobody edited anything" or "no
  // stop on this line belongs to any SKU", which are not the same claim. §65 step 3.
  async getActivity(reportId: number): Promise<ProductActivity> {
    return await withLog(this.logger, "activity_product_day_report", { reportId }, async () => {
      const window = await this.resolveWindow(reportId);

      const [downtime, quality, unattributed] = await Promise.all([
        this.productReportReaderRepository.listDowntimeEdits(window),
        // THE RANGE VARIANT, with no shift and this SKU's product. A SKU day spans
        // three shifts, and every entry is shift-keyed — so the feed widens over
        // them rather than narrowing to one, which is what listActivity (the
        // line-shift arm) does instead.
        this.qualityEntryRepository.listActivityForTarget({
          workCenterId: window.workCenterId,
          dateFrom: window.dateFrom,
          dateTo: window.dateTo,
          shift: null,
          productId: window.productId,
        }),
        this.productReportReaderRepository.countUnattributedDowntime(window),
      ]);

      const entries: ProductActivityEntry[] = [
        ...downtime.entries,
        ...quality.map(toProductQualityActivity),
      ];

      // SORTED ON `at` ALONE, leaving ties to sort stability. `id` is a PREFIXED
      // STRING here, so comparing two of them is lexicographic and would invert an
      // arm's own correct ordering for entries sharing an instant — the same note
      // both other feeds carry.
      entries.sort((a, b) => b.at.getTime() - a.at.getTime());

      const sources: ProductActivitySource[] = [
        {
          kind: "approval",
          tracked: false,
          untrackedReason: "not-applicable",
          totalMembers: 0,
          trackedMembers: 0,
        },
        {
          kind: "downtime",
          // ZERO MEMBERS IS NOT AN UNTRACKED ARM, and this is a deliberate
          // departure from the line feed's version, which reports `no-stable-id`
          // on an empty window. "These downtime records carry no stable
          // identifier" is a claim about records that do not exist. The line's
          // behaviour is left alone here because changing it is a visible copy
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
          // construction. ZERO IS A REAL ANSWER — no reject was entered by hand
          // for this SKU — where `quality.length > 0` would report a quiet day as
          // an unimplemented feature.
          tracked: true,
          untrackedReason: null,
          totalMembers: quality.length,
          trackedMembers: quality.length,
        },
      ];

      return { ...unattributed, timeZone: window.timeZone, entries, sources };
    });
  }

  // The reject dialog's Machine picker. See ProductMachineRoster for why this is
  // not the line's /machines endpoint.
  //
  // THE INSTANTS ARE RESOLVED FIRST, because oee.work_unit_shift_reports is keyed
  // on `date` — the instant a shift STARTED — and its `business_date` is nullable
  // and unbackfilled (TODOS.md §46). resolveReportWindow does it in Postgres with
  // AT TIME ZONE, for the date and zone on the SKU report's own row, so there is
  // no JS date arithmetic and no mes-master-data call.
  async getMachines(reportId: number): Promise<ProductMachineRoster> {
    return await withLog(this.logger, "machines_product_day", { reportId }, async () => {
      const window = await this.resolveWindow(reportId);
      const instants = await resolveReportWindow(
        this.goldDb,
        "day",
        window.dateFrom,
        undefined,
        window.timeZone,
      );

      return await this.productReportReaderRepository.listMachineRoster(
        { from: instants.from, to: instants.to },
        window.workCenterId,
      );
    });
  }
}

// A LEDGER ROW AS THE FEED READS IT.
//
// A DELIBERATE SECOND COPY of work-center-service.ts's toQualityActivity rather
// than a shared mapper. What the two feeds share is a WIRE SHAPE, not a type —
// work-center.ts's own argument for declaring its payload rather than importing
// work-unit's — and a shared mapper would need a shared return type, which would
// re-couple two modules' payloads to make one function. Revisit when TODOS.md §64
// makes it a third caller.
//
// `shift` IS CARRIED HERE AND NOT IN THE LINE'S VERSION. See
// ProductActivityEntry: a SKU day spans three shifts and a rework names no
// machine, so the shift is the only thing that can disambiguate two entries.
function toProductQualityActivity(entry: QualityEntry): ProductActivityEntry {
  return {
    kind: "quality",
    id: `quality:${String(entry.id)}`,
    at: new Date(entry.enteredAt),
    by: entry.enteredBy,
    byName: entry.enteredByName,
    shift: entry.shift,
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
// work-center-service.ts makes, kept. A business day is a label, so adding one to
// it is date arithmetic with no zone in it; anything that needs an INSTANT goes
// through AT TIME ZONE in SQL, where the offset is resolved for that date.
//
// `T00:00:00Z` and getUTCDate keep it in UTC end to end, so a machine running in a
// negative offset cannot roll the date backwards on the way through.
function addDay(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export { ProductReportService };
export type { TProductReportService };
