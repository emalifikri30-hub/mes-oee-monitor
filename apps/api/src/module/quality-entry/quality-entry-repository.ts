import { asOperator, traced } from "../../shared/database/postgres.js";

import type { Fragment } from "postgres";
import type { GoldDB, TransactionDB } from "../../shared/database/postgres.js";
import type {
  QualityEntry,
  QualityEntryKind,
  QualityEntryTarget,
  QualityEntryTotal,
  QualityUnitCheck,
} from "./quality-entry.js";

const TABLE = "oee.work_center_quality_entries";

// Everything the service resolved, ready to become one row. The service — not the
// client — owns every unit field here; see quality-entry-dto.ts.
type InsertQualityEntry = {
  kind: QualityEntryKind;
  workCenterId: number;
  businessDate: string;
  shift: number;
  timeZone: string;
  workUnitId: number | null;
  workUnitName: string | null;
  productId: number;
  productName: string | null;
  productCode: string | null;
  reasonId: number;
  reasonCode: string | null;
  reasonName: string | null;
  note: string | null;
  enteredQty: number;
  enteredUomId: number;
  enteredUomCode: string;
  enteredUomName: string | null;
  enteredFactorToBase: number;
  targetUomId: number;
  targetUomCode: string;
  targetUomName: string | null;
  targetFactorToBase: number;
  baseUomId: number;
  baseUomCode: string;
  unitCheck: QualityUnitCheck;
  requestId: string;
  enteredBy: string;
  enteredByName: string | null;
};

type VoidQualityEntry = {
  id: number;
  workCenterId: number;
  voidedBy: string;
  voidedByName: string | null;
  reason: string | null;
};

interface QualityEntryReader {
  listForTarget(target: TargetKey, includeVoided: boolean): Promise<QualityEntry[]>;
  listActivity(workCenterId: number, businessDate: string, shift: number): Promise<QualityEntry[]>;
  // THE RANGE VARIANT of listActivity, for a feed whose report spans more than one
  // shift — the SKU day feed today, and the machine day/month one TODOS.md §64 is
  // still open on. No `includeVoided` flag: a feed that dropped the retraction
  // would show the 500 and not the correction, which is the one thing an audit
  // trail exists to prevent, so it is not a caller's choice.
  listActivityForTarget(target: TargetKey): Promise<QualityEntry[]>;
  listActivityForMachine(
    workUnitId: number,
    businessDate: string,
    shift: number,
  ): Promise<QualityEntry[]>;
  // THE RANGE VARIANT of listActivityForMachine, and the second half of what
  // TODOS.md §64 asked for. The first half — the `work_center_id`-keyed range —
  // shipped for the SKU day feed; a machine feed needs its own because an entry
  // names a machine in a different column. The machine DAY and MONTH feeds read
  // through this.
  listActivityForMachineTarget(target: MachineTargetKey): Promise<QualityEntry[]>;
  totalsForTarget(target: TargetKey): Promise<QualityEntryTotal[]>;
  findTargetByReport(ref: ReportRef, reportId: number): Promise<ReportAnchor | undefined>;
  findShiftTarget(workCenterId: number, businessDate: string, shift: number): Promise<TargetUnit>;
  findProductAtTarget(
    workCenterId: number,
    businessDate: string,
    shift: number,
    productId: number,
  ): Promise<ReportProduct | undefined>;
  findWorkUnitName(workUnitId: number, workCenterId: number): Promise<string | null>;
}

interface QualityEntryWriter {
  insert(row: InsertQualityEntry): Promise<QualityEntry>;
  findByRequestId(requestId: string): Promise<QualityEntry | undefined>;
  void(input: VoidQualityEntry): Promise<QualityEntry | undefined>;
}

type Grain = "shift" | "day" | "month";

// WHICH REPORT AN ENTRY IS ADDRESSED BY — the SUBJECT as well as the grain.
//
// "sku" IS NOT A FOURTH GRAIN, and writing it as one would make this module's own
// vocabulary say something false. oee.product_report_wc_day (0023) is a DAY table:
// a SKU report is day grain, on a different subject. That is the axis
// lib/report-subject.ts already names in the browser ("a card MUST pick its
// endpoint from `report.grain` AND its SUBJECT").
//
// The payoff is concrete rather than tidy. quality-entry-service.ts's
// `resolveBusinessDate` branches on `grain !== "month"`, and with the SKU arm
// carrying `grain: "day"` that check — and every other grain test in this module —
// stays CORRECT UNCHANGED. A fourth grain literal would have made each one
// something the next reader has to re-derive by hand.
type ReportRef = { subject: "work-center"; grain: Grain } | { subject: "product"; grain: "day" };

// A report's window, as the ledger reads it. The ledger spans whatever the report
// spans — a shift report shows one shift's entries, a month report shows the
// month's — so the read is a range over `business_date` plus an optional shift,
// and, for a SKU report, one product.
type TargetKey = {
  workCenterId: number;
  dateFrom: string;
  dateTo: string;
  shift: number | null;
  // NULL AT LINE GRAIN, meaning "every SKU on this line". REQUIRED rather than
  // optional so a caller cannot forget it: the difference between the line's
  // ledger and one SKU's is the whole of what the SKU screen shows, and an omitted
  // field would default to the wider answer silently.
  //
  // NARROWING LOSES NOTHING, which is worth stating because 0017 makes the column
  // nullable and TODOS.md §65 worried about exactly that. The create dto requires
  // `productId` on every entry, so every row this service has ever written carries
  // one — the per-SKU ledgers therefore RECONCILE: they sum to the line's total.
  // (Contrast oee.downtime_reports.product_id, which nothing writes at all, and
  // where a product predicate needs an unattributed count beside it.)
  productId: number | null;
};

// THE SAME QUESTION KEYED ON A MACHINE, for the machine reports' feed.
//
// A SEPARATE TYPE FROM `TargetKey` RATHER THAN A NULLABLE `workCenterId` ON IT,
// and the reason is that these two are not the same read with one field swapped.
// A `TargetKey` names a LINE and answers "what counts on this line" — the ledger
// the card totals and the pipeline's override join re-reads. This one names a
// MACHINE and answers "what did an operator record against this machine", which
// is a provenance question whose quantity lands somewhere else entirely (see
// listActivityForMachineTarget). Collapsing them into one type with two nullable
// scopes would make "neither given" representable, and that reads as every entry
// in the plant.
//
// NO `productId`. A machine report has no product dimension, and there is no
// screen that asks for one machine's entries for one SKU.
type MachineTargetKey = {
  workUnitId: number;
  dateFrom: string;
  // EXCLUSIVE, with the same equal-ends inclusivity `scoped` gives `TargetKey` —
  // see machineScoped. A shift feed passes one day twice; a day or month feed
  // passes a half-open range.
  dateTo: string;
  // NULL AT DAY AND MONTH GRAIN, meaning "every shift in the range". REQUIRED
  // rather than optional for the reason TargetKey's `productId` is: an omitted
  // field would silently default to the wider answer, and a shift report showing
  // the whole day's entries is a feed that disagrees with the report it is on.
  shift: number | null;
};

// What a report id resolves to. `infeedUomCode` is the line's unit AS THE
// PIPELINE LAST WROTE IT — which is what the entry must target and what contract
// §18's join will re-check.
type ReportAnchor = {
  workCenterId: number;
  timeZone: string;
  dateFrom: string;
  dateTo: string;
  shift: number | null;
  // The SKU a product report is ABOUT. NULL for the three line reports, which have
  // no product dimension at all. The service refuses an entry naming a different
  // product, the way it refuses one naming a different business date.
  productId: number | null;
  infeedUomId: number | null;
  infeedUomCode: string | null;
};

type TargetUnit = Pick<QualityEntryTarget, "infeedUomId" | "infeedUomCode">;

// A SKU as the line's own report records it. The unit here is what the LINE
// counted that product in, which is the identity path's conversion basis when
// master data has no package list to convert through.
type ReportProduct = {
  productName: string | null;
  productCode: string | null;
  uomId: number;
  uomCode: string;
  uomName: string | null;
};

// SPAN NAMES ONLY — never interpolated into SQL; anchorSource below builds the
// FROM clause out of hardcoded literals. This map exists so a trace says which
// table answered, and it is keyed by SUBJECT then grain because the SKU table is
// not a fourth line grain.
const ANCHOR_TABLE = {
  "work-center": {
    shift: "oee.work_center_shift_reports",
    day: "oee.work_center_day_reports",
    month: "oee.work_center_month_reports",
  },
  product: { day: "oee.product_report_wc_day" },
} as const;

function anchorTable(ref: ReportRef): string {
  return ref.subject === "product"
    ? ANCHOR_TABLE.product.day
    : ANCHOR_TABLE["work-center"][ref.grain];
}

class QualityEntryRepository implements QualityEntryReader, QualityEntryWriter {
  private db: GoldDB;

  constructor({ goldDb }: { goldDb: GoldDB }) {
    this.db = goldDb;
  }

  // FOUR HARDCODED FRAGMENTS, not `this.db(ANCHOR_TABLE[...])` and not
  // `db.unsafe()`. postgres.js escapes the first as ONE identifier, dot included,
  // so it would look for a table literally named `oee.work_center_day_reports`
  // rather than `work_center_day_reports` in schema `oee`. And `unsafe()` builds
  // a QUERY, not a fragment, so interpolating one yields a column list the driver
  // never expands — which is exactly how this shipped for one test run, returning
  // rows whose every field was undefined. Four literals cannot be injected into
  // and read plainly. Same idiom as work-center's grainFrom.
  //
  // READING oee.product_report_wc_day FROM THIS MODULE IS NOT A BOUNDARY
  // VIOLATION, and it is worth saying because a reviewer will ask. This repository
  // already reads four tables it does not own — the three work_center_*_reports,
  // product_count_wc_shift and work_unit_shift_reports. AGENTS.md's rule is that
  // modules must not import each other's INTERNALS; it is not a rule about SQL,
  // and the alternative here (product-report resolving an anchor and delegating)
  // would put a second implementation of the half-open window and the infeed-unit
  // pair in another module, where a drift between them would be silent.
  private anchorFrom(ref: ReportRef): Fragment {
    if (ref.subject === "product") return this.db`oee.product_report_wc_day`;
    if (ref.grain === "shift") return this.db`oee.work_center_shift_reports`;
    if (ref.grain === "day") return this.db`oee.work_center_day_reports`;
    return this.db`oee.work_center_month_reports`;
  }

  // The projection every read of this table shares.
  //
  // SPELLED OUT rather than SELECT *, so a column added to the table does not
  // silently widen every payload, and so the numeric handling sits in one place.
  // `business_date::text` because it is a BUSINESS date and must never become a
  // zoned Date; the two round(...)::float8 casts because postgres.js returns
  // numeric as a STRING to protect precision, and without them the browser gets
  // "140.000".
  //
  // TAKES THE HANDLE rather than closing over `this.db`, and that is not a style
  // choice. A fragment is bound to the sql instance that built it, and a
  // transaction is a DIFFERENT instance — interpolating a `this.db` fragment into
  // a query running on `tx` does not expand, and the RETURNING clause comes back
  // with every field undefined. No error, no warning: just a row-shaped object
  // full of nothing. That shipped for one test run.
  private entryColumns(db: GoldDB | TransactionDB): Fragment {
    return db`
      id, kind, work_center_id, business_date::text AS business_date, shift, time_zone,
      work_unit_id, work_unit_name,
      product_id, product_name, product_code,
      reason_id, reason_code, reason_name, note,
      round(entered_qty, 3)::float8 AS entered_qty, entered_uom_code, entered_uom_name,
      round(target_qty, 3)::float8  AS target_qty,  target_uom_code,  target_uom_name,
      unit_check, entered_at, entered_by, entered_by_name,
      voided_at, voided_by, voided_by_name, void_reason, supersedes_id
    `;
  }

  // ---------------------------------------------------------------------------
  // Resolving where an entry lands
  // ---------------------------------------------------------------------------

  // A report id -> the window it covers, the SKU it is about, and the unit it
  // reports in.
  //
  // FOUR TABLES BEHIND ONE METHOD ACROSS TWO SUBJECTS, and the two differences are
  // the shift column and the product one — the same one-implementation-many-
  // prefixes shape the work-center reads use.
  //
  // ALL FOUR ARMS PROJECT THE SAME SHAPE, with a literal NULL where a table has no
  // such column, rather than omitting the column and widening the row type. A
  // missing field on a `camel`-transformed row COMPILES PERFECTLY and reads
  // `undefined` at runtime — see the note below — so a shape that varies per arm
  // is a shape three of the four callers get away with.
  //
  // THE WINDOW IS HALF-OPEN AND COMPUTED IN SQL, never in JS: a month's end is
  // `business_date + interval '1 month'`, which Postgres gets right for February
  // and for a 31st. `::text` on the way out because these are BUSINESS DATES and
  // must never become a zoned Date — TODOS §17's wrong-day bug.
  async findTargetByReport(ref: ReportRef, reportId: number): Promise<ReportAnchor | undefined> {
    return await traced("SELECT", anchorTable(ref), async () => {
      // A DAY SPAN AND THE PRODUCT — the SKU table is a day table, so its window
      // is the day arm's exactly, and the only thing that differs from a line day
      // report is that this one knows which SKU it is about.
      const span =
        ref.subject === "product"
          ? this.db`business_date::text AS date_from,
                    (business_date + interval '1 day')::date::text AS date_to,
                    NULL::smallint AS shift,
                    product_id`
          : ref.grain === "shift"
            ? this.db`business_date::text AS date_from,
                      (business_date + interval '1 day')::date::text AS date_to,
                      shift,
                      NULL::integer AS product_id`
            : ref.grain === "day"
              ? this.db`business_date::text AS date_from,
                        (business_date + interval '1 day')::date::text AS date_to,
                        NULL::smallint AS shift,
                        NULL::integer AS product_id`
              : this.db`business_date::text AS date_from,
                        (business_date + interval '1 month')::date::text AS date_to,
                        NULL::smallint AS shift,
                        NULL::integer AS product_id`;

      // CAMELCASE, because createPostgresDb sets `transform: postgres.camel` —
      // so a column selected as `work_center_id`, and an alias written
      // `AS date_from`, both arrive camelCased. A snake_case row type here
      // COMPILES PERFECTLY and reads `undefined` at runtime, and the symptom is
      // not a throw: it is an anchor full of undefined, which the next query then
      // binds and fails on. That is the 500 this method produced on
      // GET .../quality-entries. See EntryRow for the same trap one method over.
      const rows = await this.db<
        {
          workCenterId: number;
          timeZone: string;
          dateFrom: string;
          dateTo: string;
          shift: number | null;
          productId: number | null;
          infeedUomId: number | null;
          infeedUomCode: string | null;
        }[]
      >`
        SELECT work_center_id, time_zone, infeed_uom_id, infeed_uom_code, ${span}
          FROM ${this.anchorFrom(ref)}
         WHERE id = ${reportId}
      `;

      const row = rows[0];
      if (row === undefined) return undefined;

      return row;
    });
  }

  // The unit a SHIFT report reports in, for the (line, date, shift) an entry
  // actually targets.
  //
  // A SEPARATE READ FROM findTargetByReport, and not redundant with it: on a month
  // report the anchor is the MONTH row, whose infeed unit is the month's, while
  // the entry lands on ONE shift whose unit may differ (0014's per-side CHECK is
  // per row). The join in §18 keys on the shift row, so this is the unit that
  // decides.
  //
  // NO ROW IS A NORMAL ANSWER, not an error: the pipeline may not have reached
  // that shift yet, or the line may not have run it. Both null fields then mean
  // "could not check", which is what `unit_check = 'unverified'` records.
  async findShiftTarget(
    workCenterId: number,
    businessDate: string,
    shift: number,
  ): Promise<TargetUnit> {
    return await traced("SELECT", "oee.work_center_shift_reports", async () => {
      const rows = await this.db<{ infeedUomId: number | null; infeedUomCode: string | null }[]>`
        SELECT infeed_uom_id, infeed_uom_code
          FROM oee.work_center_shift_reports
         WHERE work_center_id = ${workCenterId}
           AND business_date  = ${businessDate}
           AND shift          = ${shift}
      `;

      const row = rows[0];
      return {
        infeedUomId: row?.infeedUomId ?? null,
        infeedUomCode: row?.infeedUomCode ?? null,
      };
    });
  }

  // ONE SKU AS THE REPORT ITSELF RECORDS IT — name, code and the unit it was
  // counted in.
  //
  // THE FALLBACK FOR A SKU MASTER DATA DOES NOT HAVE, and that is not an exotic
  // case: `product_work_centers` is a separate assignment upstream, and a line can
  // perfectly well have run a product nobody has linked to it. The dialog's
  // picker offers what RAN, so it must be able to resolve what ran.
  //
  // Reads oee.product_count_wc_shift — SKU View's own source — so the picker, the
  // card and this lookup cannot disagree about which products exist.
  async findProductAtTarget(
    workCenterId: number,
    businessDate: string,
    shift: number,
    productId: number,
  ): Promise<ReportProduct | undefined> {
    return await traced("SELECT", "oee.product_count_wc_shift", async () => {
      // ReportProduct is already camelCase, so the driver's transform lands it
      // directly — no mapper, and no snake_case type to drift from.
      const rows = await this.db<ReportProduct[]>`
        SELECT product_name, product_code, uom_id, uom_code, uom_name
          FROM oee.product_count_wc_shift
         WHERE work_center_id = ${workCenterId}
           AND business_date  = ${businessDate}
           AND shift          = ${shift}
           AND product_id     = ${productId}
      `;
      return rows[0];
    });
  }

  // THE MACHINE'S NAME, for the trail.
  //
  // It used to be left NULL "because the roster carries ids only and a name is a
  // nicety" — and the activity feed then rendered "machine 3" beside every
  // entry, because its fallback is `machine ${id}`. A trail that names an
  // operator and then identifies the machine by a database id is not one a
  // supervisor can read.
  //
  // FROM GOLD, NOT MASTER DATA. oee.work_unit_shift_reports carries
  // work_unit_name denormalised and NOT NULL, so this costs no upstream call on
  // a write path — the same reason the line cascade stopped fetching a roster.
  //
  // Scoped by work_center_id as well, so a machine id from another line resolves
  // to NULL rather than borrowing a name it has no claim to.
  async findWorkUnitName(workUnitId: number, workCenterId: number): Promise<string | null> {
    return await traced("SELECT", "oee.work_unit_shift_reports", async () => {
      const rows = await this.db<{ workUnitName: string | null }[]>`
        SELECT work_unit_name
          FROM oee.work_unit_shift_reports
         WHERE work_unit_id   = ${workUnitId}
           AND work_center_id = ${workCenterId}
         ORDER BY date DESC
         LIMIT 1
      `;
      return rows[0]?.workUnitName ?? null;
    });
  }

  // ---------------------------------------------------------------------------
  // Reading the ledger
  // ---------------------------------------------------------------------------

  async listForTarget(target: TargetKey, includeVoided: boolean): Promise<QualityEntry[]> {
    return await traced("SELECT", TABLE, async () => {
      const rows = await this.db<EntryRow[]>`
        SELECT ${this.entryColumns(this.db)}
          FROM oee.work_center_quality_entries
         WHERE ${this.scoped(target)}
           ${includeVoided ? this.db`` : this.db`AND voided_at IS NULL`}
         -- Newest first, with the id breaking a tie rather than leaving one:
         -- two entries in the same transaction share entered_at to the
         -- microsecond, and without the tiebreak they could swap places between
         -- identical requests. Same rule aggregateRejectRows states for its
         -- ordering. (No backticks in here: this is a tagged template, and one
         -- would terminate the string.)
         ORDER BY entered_at DESC, id DESC
      `;

      return rows.map(toEntry);
    });
  }

  // The live figures the card shows, per kind and per unit.
  //
  // GROUPED BY UNIT rather than summed across it — see QualityEntryTotal. And
  // `voided_at IS NULL` here with no option to include them: a voided entry is
  // trail, never a figure. That is the same filter contract §18's aggregate uses,
  // deliberately, so the card and the pipeline can never disagree about which
  // rows count.
  async totalsForTarget(target: TargetKey): Promise<QualityEntryTotal[]> {
    return await traced("SELECT", TABLE, async () => {
      // camelCase on the way out, per the driver's transform — see EntryRow. The
      // SQL still aliases `uom_code`, and `postgres.camel` is what bridges them.
      const rows = await this.db<QualityEntryTotal[]>`
        SELECT kind,
               target_uom_code                AS uom_code,
               -- numeric comes back as a STRING from postgres.js to protect
               -- precision, so it is rounded and cast or it reaches the browser
               -- as "620.000". Same discipline as listProductCount.
               round(sum(target_qty), 3)::float8 AS qty,
               count(*)::int                  AS entries
          FROM oee.work_center_quality_entries
         WHERE ${this.scoped(target)}
           AND voided_at IS NULL
         GROUP BY kind, target_uom_code
         ORDER BY kind, target_uom_code
      `;

      // No mapper: the projection already IS QualityEntryTotal once the transform
      // has run, and `qty` is cast to float8 in the SQL rather than arriving as a
      // numeric string.
      return rows;
    });
  }

  // THE ACTIVITY FEED's arm — every entry against one line shift, INCLUDING the
  // voided ones.
  //
  // A SEPARATE METHOD FROM listForTarget, and the difference is the point: the
  // ledger answers "what counts", this answers "what happened". A void IS an
  // event — the operator corrected themselves, and a feed that hid it would show
  // the 500 and not the retraction, which is the one thing an audit trail exists
  // to prevent. So it never takes an `includeVoided` flag: the answer is always
  // yes, and a flag would be a way to get it wrong.
  //
  // Keyed on (line, business_date, shift) rather than on the instant window the
  // rest of the feed uses, because an entry is shift-keyed by construction and has
  // no instant to fall inside.
  async listActivity(
    workCenterId: number,
    businessDate: string,
    shift: number,
  ): Promise<QualityEntry[]> {
    return await this.listActivityForTarget({
      workCenterId,
      dateFrom: businessDate,
      // Half-open over one day. The shift narrows it, so the range is only here
      // to reuse `scoped` rather than to widen anything.
      dateTo: businessDate,
      shift,
      // Every SKU on the line: a line shift's feed reports what happened on the
      // LINE, and an entry belongs in it whichever product it named.
      productId: null,
    });
  }

  // THE SAME ARM OVER A RANGE, for a feed whose report spans more than one shift.
  //
  // listActivity above is this one with the range collapsed to a day and a shift
  // named; expressing it that way rather than the other way round is deliberate,
  // because it leaves exactly ONE statement of "what the feed shows" — always
  // including voided rows — where two would be two chances to differ about the one
  // thing this arm exists for.
  //
  // THE WIDENING TODOS.md §64 ASKS FOR, met from the SKU side first. §64 wants it
  // for the machine day and month feeds, whose current empty quality arm reports
  // `no-source` and means "this feed does not carry them" while reading as "none
  // were entered" — opposite claims about an identical empty panel. That arm is
  // keyed (work_unit_id, ...) and still needs its own sibling; this one is the
  // (work_center_id, ...) half.
  async listActivityForTarget(target: TargetKey): Promise<QualityEntry[]> {
    return await this.listForTarget(target, true);
  }

  // THE MACHINE feed's arm — every entry an operator ATTRIBUTED TO THIS MACHINE.
  //
  // WHY A MACHINE FEED SHOWS THESE AT ALL, given the quantity lands on the LINE:
  // the operator picked this machine. They saw the rejects here, they said so,
  // and a trail on this machine's report that omitted it would be missing the one
  // fact they contributed. Where the number lands is a measurement question; what
  // an operator recorded against a machine is an audit question, and they have
  // different right answers.
  //
  // REWORK NEVER APPEARS, and that falls out of the schema rather than from a
  // filter: a rework carries no work_unit_id (the dialog does not ask), so
  // scoping by one excludes it structurally. That matches the rule as stated —
  // a reject names a machine, a rework does not.
  //
  // INCLUDES VOIDED ROWS, like the line feed: a void is an event, and a trail
  // that hid the retraction would show the 500 and not the correction.
  async listActivityForMachine(
    workUnitId: number,
    businessDate: string,
    shift: number,
  ): Promise<QualityEntry[]> {
    return await this.listActivityForMachineTarget({
      workUnitId,
      // One day, twice. `machineScoped` reads equal ends as inclusive, so the
      // range is only here to reuse that one fragment rather than to widen
      // anything — exactly how `listActivity` relates to `listActivityForTarget`
      // on the line side.
      dateFrom: businessDate,
      dateTo: businessDate,
      shift,
    });
  }

  // THE SAME ARM OVER A RANGE, for a MACHINE feed whose report spans more than one
  // shift — the day and month ones. TODOS.md §64's remaining half.
  //
  // `listActivityForMachine` above is this one with the range collapsed to a day
  // and a shift named. Expressing it in that direction rather than the other is
  // deliberate and is the same call `listActivityForTarget` made: it leaves exactly
  // ONE statement of "what a machine's feed shows" — always including voided rows
  // — where two would be two chances to differ about the one thing this arm exists
  // for.
  async listActivityForMachineTarget(target: MachineTargetKey): Promise<QualityEntry[]> {
    return await traced("SELECT", TABLE, async () => {
      const rows = await this.db<EntryRow[]>`
        SELECT ${this.entryColumns(this.db)}
          FROM oee.work_center_quality_entries
         WHERE ${this.machineScoped(target)}
         ORDER BY entered_at DESC, id DESC
      `;
      return rows.map(toEntry);
    });
  }

  // ONE fragment for both reads, so the ledger and its totals can never be
  // computed over different rows — the arrangement aggregateRejectRows and
  // DowntimeReaderRepository.clipped both use, and for the same reason.
  //
  // HALF-OPEN on the date, so a month's last day is in and the next month's first
  // is not.
  private scoped({ workCenterId, dateFrom, dateTo, shift, productId }: TargetKey) {
    return this.db`
      work_center_id = ${workCenterId}
        AND business_date >= ${dateFrom}
        -- INCLUSIVE when the two ends are equal, half-open otherwise. The report
        -- windows always pass a range (a shift report's dateTo is the next day);
        -- listActivity passes ONE day twice, because an entry is shift-keyed and
        -- there is no range to speak of. A strictly half-open comparison would
        -- match nothing there — the zero-width-range trap LineWindow's own comment
        -- warns about, met from the other direction.
        AND business_date <${dateFrom === dateTo ? this.db`=` : this.db``} ${dateTo}
        ${shift === null ? this.db`` : this.db`AND shift = ${shift}`}
        -- ONE SKU, or every SKU on the line. Absent when null rather than written
        -- as an IS NOT DISTINCT FROM comparison: a line's ledger is the whole
        -- line's, and a null-matching predicate would narrow it to the rows with
        -- no product — which, since the create dto requires one, is none of them.
        -- (No backticks in here, per the note above: one would end the template.)
        ${productId === null ? this.db`` : this.db`AND product_id = ${productId}`}
    `;
  }

  // THE MACHINE SIDE of the fragment above, for the machine feed's three grains.
  //
  // A SECOND FRAGMENT RATHER THAN A WIDENED `scoped`, and this is the one place
  // in this file where a second statement of a predicate is right. `scoped` states
  // what belongs to a LINE's ledger — the rows the card totals and contract §18's
  // override join re-reads — and every caller of it is a ledger read. This states
  // what an operator RECORDED AGAINST A MACHINE, which is a different question
  // with a different answer: a rework has no `work_unit_id` at all, so this
  // fragment structurally excludes a class of row that `scoped` must include.
  // Folding the two together behind a nullable scope would make that exclusion
  // look like a filter somebody could lift.
  //
  // REWORK NEVER MATCHES, and it falls out of the schema rather than from a
  // predicate: the dialog does not ask a rework which machine it was on, so the
  // column is NULL and `work_unit_id = $1` drops it. That matches the rule as
  // stated — a reject names a machine, a rework does not.
  private machineScoped({ workUnitId, dateFrom, dateTo, shift }: MachineTargetKey) {
    return this.db`
      work_unit_id = ${workUnitId}
        AND business_date >= ${dateFrom}
        -- INCLUSIVE when the two ends are equal, half-open otherwise — the same
        -- rule the line fragment above carries, and for the same reason: the
        -- shift-grain caller passes ONE day twice because an entry is shift-keyed
        -- and there is no range to speak of, while the day and month callers pass
        -- a real half-open range. A strictly half-open comparison would match
        -- nothing at shift grain.
        -- (No backticks in here, per the note above: one would end the template.)
        AND business_date <${dateFrom === dateTo ? this.db`=` : this.db``} ${dateTo}
        ${shift === null ? this.db`` : this.db`AND shift = ${shift}`}
    `;
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  // IDEMPOTENCY'S READ HALF. The unique index makes a retry fail; this makes it
  // succeed with the row the first attempt wrote, which is what the browser needs
  // to render rather than an error it cannot act on.
  async findByRequestId(requestId: string): Promise<QualityEntry | undefined> {
    return await traced("SELECT", TABLE, async () => {
      const rows = await this.db<EntryRow[]>`
        SELECT ${this.entryColumns(this.db)}
          FROM oee.work_center_quality_entries
         WHERE request_id = ${requestId}
      `;
      const row = rows[0];
      return row === undefined ? undefined : toEntry(row);
    });
  }

  // ONE ROW, INSIDE A TRANSACTION THAT STAMPS THE OPERATOR.
  //
  // The transaction has one statement in it, which looks like ceremony and is
  // not: `asOperator(tx)` is what sets `application_name` for the write_audit
  // trigger, and it uses set_config(..., is_local => true) so the name reverts at
  // COMMIT. Outside a transaction there would be nothing to revert at, and
  // postgres.js pools connections — a leaked name would label a later pure read
  // as an operator write.
  //
  // ON CONFLICT DO NOTHING on the request id, so a double-submitted form inserts
  // once. The service reads the existing row back when nothing is returned.
  async insert(row: InsertQualityEntry): Promise<QualityEntry> {
    return await traced("INSERT", TABLE, async () => {
      const inserted = await this.db.begin(async (tx) => {
        await asOperator(tx);

        return await tx<EntryRow[]>`
          INSERT INTO oee.work_center_quality_entries (
            kind, work_center_id, business_date, shift, time_zone,
            work_unit_id, work_unit_name,
            product_id, product_name, product_code,
            reason_id, reason_code, reason_name, note,
            entered_qty, entered_uom_id, entered_uom_code, entered_uom_name,
            entered_factor_to_base,
            target_uom_id, target_uom_code, target_uom_name, target_factor_to_base,
            base_uom_id, base_uom_code,
            unit_check, request_id, entered_by, entered_by_name
          ) VALUES (
            ${row.kind}, ${row.workCenterId}, ${row.businessDate}, ${row.shift}, ${row.timeZone},
            ${row.workUnitId}, ${row.workUnitName},
            ${row.productId}, ${row.productName}, ${row.productCode},
            ${row.reasonId}, ${row.reasonCode}, ${row.reasonName}, ${row.note},
            ${row.enteredQty}, ${row.enteredUomId}, ${row.enteredUomCode}, ${row.enteredUomName},
            ${row.enteredFactorToBase},
            ${row.targetUomId}, ${row.targetUomCode}, ${row.targetUomName},
            ${row.targetFactorToBase},
            ${row.baseUomId}, ${row.baseUomCode},
            ${row.unitCheck}, ${row.requestId}, ${row.enteredBy}, ${row.enteredByName}
          )
          ON CONFLICT (request_id) DO NOTHING
          RETURNING ${this.entryColumns(tx)}
        `;
      });

      const row0 = inserted[0];
      if (row0 !== undefined) return toEntry(row0);

      // The conflict arm. The row exists because this exact submission already
      // landed, so returning it makes the retry a no-op from the caller's side.
      const existing = await this.findByRequestId(row.requestId);
      if (existing === undefined) {
        // Unreachable: DO NOTHING fired, so a row with this request_id exists.
        // Thrown rather than `!` for the reason shared/actor.ts gives — a guard
        // turns a future regression into an error at its cause.
        throw new Error(`quality entry ${row.requestId} conflicted but could not be read back`);
      }
      return existing;
    });
  }

  // THE ONLY MUTATION THIS TABLE PERMITS, and the trigger in 0017 enforces that
  // rather than trusting this method to be the only writer.
  //
  // `voided_at IS NULL` in the WHERE is not redundant with the trigger's own
  // check: it makes a second void return NO ROW — which the service turns into a
  // 409 — instead of raising, which would surface as a 500. The trigger stays as
  // the guarantee against a writer that is not this one.
  //
  // Scoped by work_center_id as well as id, so a void issued from one line's
  // screen cannot reach another line's entry by id alone.
  async void(input: VoidQualityEntry): Promise<QualityEntry | undefined> {
    return await traced("UPDATE", TABLE, async () => {
      const rows = await this.db.begin(async (tx) => {
        await asOperator(tx);

        return await tx<EntryRow[]>`
          UPDATE oee.work_center_quality_entries
             SET voided_at      = now(),
                 voided_by      = ${input.voidedBy},
                 voided_by_name = ${input.voidedByName},
                 void_reason    = ${input.reason}
           WHERE id             = ${input.id}
             AND work_center_id = ${input.workCenterId}
             AND voided_at IS NULL
          RETURNING ${this.entryColumns(tx)}
        `;
      });

      const row = rows[0];
      return row === undefined ? undefined : toEntry(row);
    });
  }
}

// THE DRIVER ALREADY CAMEL-CASES. `createPostgresDb` sets
// `transform: postgres.camel`, so a column selected as `entered_at` arrives as
// `enteredAt` — which means a snake_case row type here compiles perfectly and
// every field reads `undefined` at runtime. This file shipped that way for one
// test run; the aliases in `entryColumns` are still snake_case because that is
// what the SQL says, and the transform is what bridges them.
//
// So this type is the payload's shape with THREE exceptions, and those are the
// only reason a mapper exists at all.
type EntryRow = Omit<QualityEntry, "id" | "enteredAt" | "voidedAt" | "supersedesId"> & {
  // bigint. postgres.js returns it as a STRING above the safe-integer range and
  // as a number below it, so a payload would sometimes carry "12" and sometimes
  // 12 — which the browser compares wrongly with ===.
  id: string | number;
  supersedesId: string | number | null;
  // Dates, which the envelope serialises inconsistently unless they are pinned to
  // ISO here.
  enteredAt: Date;
  voidedAt: Date | null;
};

function toEntry(row: EntryRow): QualityEntry {
  return {
    ...row,
    id: Number(row.id),
    supersedesId: row.supersedesId === null ? null : Number(row.supersedesId),
    enteredAt: row.enteredAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
  };
}

export { QualityEntryRepository };
export type {
  ReportRef,
  Grain,
  ReportProduct,
  InsertQualityEntry,
  MachineTargetKey,
  QualityEntryReader,
  QualityEntryWriter,
  ReportAnchor,
  TargetKey,
  TargetUnit,
  VoidQualityEntry,
};
