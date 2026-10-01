import { HTTPException } from "hono/http-exception";

import { withLog, type Logger } from "@molca/utils";
import { baseLogger, getRequestContext } from "@molca/observability";

import { requireRole } from "../../shared/actor.js";
import { resolveShiftWindow, toShiftId } from "../../shared/shift-window.js";

import type { Actor } from "../../shared/actor.js";
import type { CreateQualityEntryInput } from "./quality-entry-dto.js";
import type { GoldDB } from "../../shared/database/postgres.js";
import type { MasterDataServiceContract } from "../master-data/master-data-service.js";
import type { OperatorRoles } from "../../shared/config/config.js";
import type { QualityEntry, QualityEntryList, QualityEntryTotal } from "./quality-entry.js";
import type {
  QualityEntryReader,
  QualityEntryWriter,
  ReportAnchor,
  ReportRef,
} from "./quality-entry-repository.js";
import type { WorkCenterReportWriter } from "../work-center/work-center-repository.js";

type QualityEntryServiceDeps = {
  qualityEntryRepository: QualityEntryReader & QualityEntryWriter;
  // FOR THE FREEZE ONLY. Injected across a module boundary the way the downtime
  // service injects workUnitReportReaderRepository, and for the same reason: the
  // question "is this line shift approved" already has exactly one implementation
  // and a second would be a second definition of "approved". Awilix registration
  // is the sanctioned seam here — this is not an import of another module's
  // internals.
  workCenterReportWriterRepository: WorkCenterReportWriter;
  masterDataService: MasterDataServiceContract;
  goldDb: GoldDB;
  operatorRoles: OperatorRoles;
  logger?: Logger;
};

class QualityEntryService {
  private repo: QualityEntryReader & QualityEntryWriter;
  private lineWriter: WorkCenterReportWriter;
  private masterData: MasterDataServiceContract;
  private goldDb: GoldDB;
  private operatorRoles: OperatorRoles;
  private fallbackLogger: Logger;

  constructor({
    qualityEntryRepository,
    workCenterReportWriterRepository,
    masterDataService,
    goldDb,
    operatorRoles,
    logger,
  }: QualityEntryServiceDeps) {
    this.repo = qualityEntryRepository;
    this.lineWriter = workCenterReportWriterRepository;
    this.masterData = masterDataService;
    this.goldDb = goldDb;
    this.operatorRoles = operatorRoles;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  // ---------------------------------------------------------------------------
  // Reading the ledger
  // ---------------------------------------------------------------------------

  // What has been entered against this report's window.
  //
  // THE WINDOW IS THE REPORT'S, not the entry's: a shift report shows one shift's
  // entries, a month report shows the month's. That is what makes the card's
  // "+140 BAG entered by hand" figure mean the same thing as the tile beside it
  // eventually will.
  async list(ref: ReportRef, reportId: number, includeVoided: boolean): Promise<QualityEntryList> {
    const anchor = await this.anchor(ref, reportId);

    const key = {
      workCenterId: anchor.workCenterId,
      dateFrom: anchor.dateFrom,
      dateTo: anchor.dateTo,
      shift: anchor.shift,
      // NULL AT LINE GRAIN — the whole line's ledger — and this SKU's on a product
      // report. A SKU report IS one SKU, so a ledger showing another SKU's entries
      // under this report's Reject tile would be the screen contradicting itself.
      //
      // NARROWING LOSES NOTHING: the create dto requires productId on every entry,
      // so the per-SKU ledgers sum to the line's. TargetKey says the same at
      // length, because it is the thing a supervisor will challenge.
      productId: anchor.productId,
    };

    const [items, totals] = await Promise.all([
      this.repo.listForTarget(key, includeVoided),
      this.repo.totalsForTarget(key),
    ]);

    return { items, totals, targetUomCode: anchor.infeedUomCode };
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  //                          create(), end to end
  //
  //   [1] requireRole                   403 before anything else is touched
  //   [2] resolve the report            404 on a bad id; gives the line, the
  //                                     window, the unit and — on a SKU report —
  //                                     the product
  //   [3] resolve WHICH DAY             the report supplies it at every grain but
  //                                     month, where the operator names one
  //   [4] resolve WHICH SKU             the report supplies it on a product
  //                                     report; 400 when the client disagrees
  //   [5] the FREEZE                    409 if that shift is signed off
  //   [6] resolve the CONVERSION        master data; 400 on a stale picker
  //   [7] resolve the labels            reason and machine names, snapshotted
  //   [8] insert                        idempotent on requestId
  //
  // WHICH SHIFT is not a step: it is always `input.shift`, required by the dto at
  // every grain and on every subject. A shift report knows it and the dialog
  // prefills it; a day, month or SKU screen asks the operator, because
  // oee.work_center_quality_entries is keyed (line, business_date, SHIFT) whatever
  // screen produced the row — which is what lets contract §18 be ONE dbt join.
  //
  // [1] IS FIRST DELIBERATELY, matching approveLineShift: a refusal must not call
  // mes-master-data, must not open a transaction and must not read the report. A
  // 403 is not a conflict and must not cost what one costs.
  async create(
    ref: ReportRef,
    reportId: number,
    input: CreateQualityEntryInput,
    actor: Actor,
  ): Promise<QualityEntry> {
    requireRole(actor, this.operatorRoles.enterQuality, {
      metric: "enter_quality",
      message: "record reject or rework on this report",
    });

    return await withLog(
      this.logger,
      "create_quality_entry",
      { reportId, subject: ref.subject, grain: ref.grain, kind: input.kind },
      async () => {
        const anchor = await this.anchor(ref, reportId);
        const businessDate = this.resolveBusinessDate(ref, anchor, input.businessDate);
        const productId = this.resolveProductId(anchor, input.productId);

        await this.refuseIfFrozen(anchor, businessDate, input.shift);

        const conversion = await this.resolveConversion(
          anchor,
          businessDate,
          input.shift,
          productId,
          input.packageId,
        );

        const [reason, workUnitName] = await Promise.all([
          this.resolveReason(anchor.workCenterId, input.reasonId),
          this.resolveWorkUnitName(anchor.workCenterId, input),
        ]);

        return await this.repo.insert({
          kind: input.kind,
          workCenterId: anchor.workCenterId,
          businessDate,
          shift: input.shift,
          timeZone: anchor.timeZone,
          workUnitId: input.kind === "reject" ? input.workUnitId : null,
          workUnitName,
          productId,
          productName: conversion.productName,
          productCode: conversion.productCode,
          reasonId: input.reasonId,
          reasonCode: reason.code,
          reasonName: reason.name,
          note: input.note ?? null,
          enteredQty: input.quantity,
          ...conversion.units,
          unitCheck: conversion.unitCheck,
          requestId: input.requestId,
          enteredBy: actor.subject,
          // DISPLAY ONLY, and nullable. shared/actor.ts: "The durable identity is
          // always `sub`." The requirement asks for "the username/name" with the
          // id as an afterthought; it is the other way round, because a display
          // name changes and a trail keyed on one stops joining.
          enteredByName: actor.name,
        });
      },
    );
  }

  // A correction. The entry stays; a void is recorded on it and the figure stops
  // counting. See 0017 for why there is no edit.
  async void(
    ref: ReportRef,
    reportId: number,
    entryId: number,
    reason: string | null,
    actor: Actor,
  ): Promise<QualityEntry> {
    requireRole(actor, this.operatorRoles.enterQuality, {
      metric: "void_quality",
      message: "void a reject or rework entry on this report",
    });

    return await withLog(this.logger, "void_quality_entry", { reportId, entryId }, async () => {
      const anchor = await this.anchor(ref, reportId);

      const voided = await this.repo.void({
        id: entryId,
        // SCOPED BY THE LINE, so an entry id from another line's screen cannot be
        // voided through this one. Six report tables with independent sequences
        // makes a plausible-looking wrong id cheap to produce.
        workCenterId: anchor.workCenterId,
        voidedBy: actor.subject,
        voidedByName: actor.name,
        reason,
      });

      if (voided === undefined) {
        // The repository's WHERE covers three cases at once — no such id, another
        // line's id, and already voided — and they are deliberately answered the
        // same way. Distinguishing them would need a second read whose only
        // product is telling a caller which of three mistakes they made, and the
        // middle one is a thing the caller should not learn.
        throw new HTTPException(409, {
          message: "this entry does not exist on this report, or has already been voided",
        });
      }

      return voided;
    });
  }

  // ---------------------------------------------------------------------------
  // The pieces
  // ---------------------------------------------------------------------------

  private async anchor(ref: ReportRef, reportId: number): Promise<ReportAnchor> {
    const anchor = await this.repo.findTargetByReport(ref, reportId);
    if (anchor === undefined) throw new HTTPException(404, { message: "report not found" });
    return anchor;
  }

  // WHICH BUSINESS DATE the entry lands on. The answer differs per grain and the
  // month case is the reason the form has a date picker at all.
  //
  //   shift, day  the report covers ONE business date, so it supplies it. A
  //               client that sends a different one is refused rather than
  //               silently corrected — it means the screen and the server
  //               disagree about which day is on display.
  //   month       the report spans ~30 of them, so the operator names one, and it
  //               must fall inside the month. Without the bound, a mistyped year
  //               puts an entry on a report nobody is looking at, where it will be
  //               applied by the pipeline and never noticed.
  //   SKU         the day arm, UNCHANGED, and that is the whole reason ReportRef
  //               carries a subject and a grain rather than a fourth grain
  //               literal: oee.product_report_wc_day IS a day table, so a SKU
  //               report covers one business date and this method was already
  //               right about it.
  private resolveBusinessDate(
    ref: ReportRef,
    anchor: ReportAnchor,
    supplied: string | undefined,
  ): string {
    if (ref.grain !== "month") {
      if (supplied !== undefined && supplied !== anchor.dateFrom) {
        throw new HTTPException(400, {
          message: `this report covers ${anchor.dateFrom}, not ${supplied}`,
        });
      }
      return anchor.dateFrom;
    }

    if (supplied === undefined) {
      throw new HTTPException(400, {
        message: "a month report spans many days, so an entry must name its business date",
      });
    }
    // Half-open, matching the anchor: the month's last day is in and the next
    // month's first is out. String comparison is exact on 'YYYY-MM-DD' and does
    // not build a zoned Date — see quality-entry-dto.ts.
    if (supplied < anchor.dateFrom || supplied >= anchor.dateTo) {
      throw new HTTPException(400, {
        message: `${supplied} is outside this report's month`,
      });
    }
    return supplied;
  }

  // WHICH SKU the entry lands on — resolveBusinessDate's sibling, and written to
  // look like it on purpose.
  //
  //   line reports   the anchor knows no product (these tables have no product
  //                  dimension at all), so the client's choice stands. This is the
  //                  shipped behaviour and nothing about it changes.
  //   SKU reports    the report IS one SKU, so it supplies it, and a client naming
  //                  a different one is REFUSED.
  //
  // REFUSED RATHER THAN SILENTLY REBASED to the anchor's product, for three
  // reasons and the second is the one that matters most:
  //
  //   * It is the rule resolveBusinessDate already applies one field over, for the
  //     stated reason — a mismatch means the screen and the server disagree about
  //     what is on display, and correcting it hides that.
  //   * product_id IS THE CONVERSION BASIS (0017's ck_wcqe_basis). Rebasing would
  //     run resolveConversion through a DIFFERENT product's packages[] and write a
  //     wrong quantity into an append-only ledger the pipeline will apply — a
  //     plausible number with no way back except a void.
  //   * It is the WRITE half of a spoof the read path already refuses.
  //     product-report-service's resolveWindow takes productId off the row for
  //     exactly this: "a ?productId= on these routes would let a caller ask for
  //     SKU B's rejects against SKU A's report and get a coherent-looking answer."
  //
  // And without it the entry would VANISH: the ledger read narrows by product, so
  // an entry written with SKU B against SKU A's report shows on neither screen and
  // is still summed by contract §18's join.
  //
  // productId STAYS REQUIRED IN THE DTO rather than becoming optional-and-defaulted
  // the way businessDate is. A business date has exactly one possible value and
  // means nothing else; a conversion basis that was inferred rather than named is
  // the thing ck_wcqe_basis exists to make explicit.
  private resolveProductId(anchor: ReportAnchor, supplied: number): number {
    if (anchor.productId === null) return supplied;

    if (supplied !== anchor.productId) {
      throw new HTTPException(400, {
        message: `this report covers product ${String(anchor.productId)}, not ${String(supplied)}`,
      });
    }

    return anchor.productId;
  }

  // THE FREEZE. Approving a line closes every machine shift report on it, so
  // "is this line shift approved" is the same question the cascade answers, asked
  // through the same repository method — which is what stops a second definition
  // of "approved" existing.
  //
  // ALL of them closed, matching useReportApproved in the browser and the line's
  // own Status tile. A partially approved line is still editable, deliberately:
  // some machine on it is still open, so the shift is not signed off.
  private async refuseIfFrozen(
    anchor: ReportAnchor,
    businessDate: string,
    shift: number,
  ): Promise<void> {
    const shiftId = toShiftId(shift);
    if (shiftId === undefined) {
      // Unreachable — the dto constrains shift to 1..3. A guard rather than a
      // non-null assertion, because what it protects is an entry landing on a
      // shift nobody meant.
      throw new HTTPException(400, { message: "shift must be 1, 2 or 3" });
    }

    const window = await resolveShiftWindow(this.goldDb, businessDate, shiftId, anchor.timeZone);

    const summary = await this.lineWriter.summariseLineShift({
      workCenterId: anchor.workCenterId,
      from: window.from,
      to: window.to,
      shift,
    });

    if (summary.machinesFound > 0 && summary.machinesClosed === summary.machinesFound) {
      throw new HTTPException(409, {
        message:
          "this shift has been approved. Reopen it from the line report before recording reject or rework.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // THE CONVERSION — the one place a silently wrong number could be produced
  // ---------------------------------------------------------------------------
  //
  // Everything here resolves SERVER-SIDE from ids the client sent. The client
  // never sends a factor or a converted quantity, because a client that could
  // send one could send a conversion nobody checked.
  //
  // The arithmetic itself is NOT done here — `target_qty` is a generated column
  // (0017), so Postgres computes it from the two factors this stores. That is
  // deliberate: a figure computed here and a figure computed by a BI tool off the
  // same row could disagree, and the row is what the pipeline will sum.
  private async resolveConversion(
    anchor: ReportAnchor,
    businessDate: string,
    shift: number,
    productId: number,
    packageId: number | undefined,
  ) {
    // THE TARGET IS THE SHIFT ROW'S UNIT, NOT THE ANCHOR'S. On a month report the
    // anchor is the MONTH row, whose infeed unit is the month's; the entry lands
    // on ONE shift, and 0014's per-side CHECK is per row, so those can differ.
    // Contract §18's join keys on the shift row, so the shift row's unit is the
    // one that decides whether this entry will ever be applied.
    const shiftUnit = await this.repo.findShiftTarget(anchor.workCenterId, businessDate, shift);

    // NO SHIFT ROW YET, OR ITS UNIT DISAGREED. Both are legitimate — the pipeline
    // may not have reached that shift, and 0014 says a NULL infeed unit means
    // "the members disagreed" — so the entry is ACCEPTED and marked, rather than
    // refused. Refusing would make month-grain entry and backfill unusable, and
    // §18's join decides in the end either way.
    const targetUomId = shiftUnit.infeedUomId ?? anchor.infeedUomId;
    const targetUomCode = shiftUnit.infeedUomCode ?? anchor.infeedUomCode;

    if (targetUomId === null || targetUomCode === null) {
      throw new HTTPException(409, {
        message:
          "this line has not reported a unit for that shift, so there is nothing to record the quantity in",
      });
    }

    const unitCheck: "verified" | "unverified" =
      shiftUnit.infeedUomId === null ? "unverified" : "verified";

    // ---------------------------------------------------------------------
    // THE IDENTITY PATH — a SKU the line RAN that master data has not linked
    // ---------------------------------------------------------------------
    //
    // `product_work_centers` is a separate assignment upstream, so a line can
    // perfectly well have produced something nobody has linked to it. The
    // dialog's picker offers what RAN (that is the whole point of it), so this
    // service has to be able to record against it.
    //
    // With no package list there is no star to convert through — so the quantity
    // is entered in the LINE'S OWN unit and the conversion is exactly 1. Both
    // factors take the same value, which is what ck_wcqe_identity requires, and
    // ck_wcqe_basis is satisfied because a product is still named.
    //
    // The labels come from the line's own report row rather than from master
    // data, so a trail read months later still says what the operator picked.
    if (packageId === undefined) {
      const reported = await this.repo.findProductAtTarget(
        anchor.workCenterId,
        businessDate,
        shift,
        productId,
      );

      if (reported === undefined) {
        throw new HTTPException(400, {
          message: "that product did not run on this line for that shift",
        });
      }

      // THE ONE THING THIS PATH CANNOT DO. Without a package list there is no
      // factor to convert by, so the SKU must have been counted in the unit the
      // line reports in. When it was not, refusing is the only honest answer —
      // the alternative is assuming 1.0 between two genuinely different units.
      //
      // COMPARED BY CODE, not by id. See the converting path below for why: every
      // aggregate in this service already treats uom_code as a unit's identity,
      // and an id that drifts between Gold and master data is a records problem
      // rather than two different units.
      if (!sameUnitCode(reported.uomCode, targetUomCode)) {
        throw new HTTPException(400, {
          message: `this SKU is counted in ${reported.uomCode} and the line reports in ${targetUomCode}, and master data has no conversion between them for this product`,
        });
      }

      return {
        productName: reported.productName,
        productCode: reported.productCode,
        unitCheck,
        units: {
          enteredUomId: targetUomId,
          enteredUomCode: targetUomCode,
          enteredUomName: reported.uomName,
          enteredFactorToBase: 1,
          targetUomId,
          targetUomCode,
          targetUomName: reported.uomName,
          targetFactorToBase: 1,
          baseUomId: targetUomId,
          baseUomCode: targetUomCode,
        },
      };
    }

    // ---------------------------------------------------------------------
    // THE CONVERTING PATH — a SKU master data knows, with packages to pick from
    // ---------------------------------------------------------------------
    const product = await this.masterData.getProduct(productId);
    if (product === undefined) {
      throw new HTTPException(400, { message: "that product no longer exists" });
    }

    const entered = product.packages.find((pkg) => pkg.id === packageId);
    if (entered === undefined || entered.uom === null) {
      throw new HTTPException(400, {
        message: `${product.name} is not counted in that unit`,
      });
    }

    // THE CONVERSION GOES THROUGH THE PRODUCT'S BASE, NOT TO IT. Several packages
    // share one base, so any two convert through it — which is why the condition
    // is "the line's unit is one of this product's packages" and not the far
    // stricter "the product's base IS the line's unit".
    // ID FIRST, THEN CODE — and the fallback is the fix for a real refusal.
    //
    // This matched on uom ID alone, and refused "BAG to BAG" whenever Gold and
    // master data held that unit under two different records. That is a records
    // problem, not two different units, and refusing made the feature unusable
    // rather than safe.
    //
    // THE PRECEDENT IS THIS SERVICE'S OWN: every aggregate in shared/loss-aggregate.ts
    // decides whether a bucket has one unit with `count(DISTINCT uom_code) = 1`
    // and labels it with `min(uom_code)`. The reader has always treated the CODE
    // as a unit's identity; the conversion path was the outlier for using the id.
    //
    // The id match still wins when it exists, so nothing changes on clean data.
    // When only the code matches, the entry is still written — and marked
    // `unverified`, because "we could not fully confirm the unit" is exactly what
    // that column is for.
    const byId = product.packages.find((pkg) => pkg.uom?.id === targetUomId);
    const byCode = product.packages.find((pkg) => sameUnitCode(pkg.uom?.code, targetUomCode));
    const target = byId ?? byCode;

    if (target === undefined) {
      // THE MESSAGE HAS TO NAME WHAT ACTUALLY DIFFERS, because the match is on
      // uom ID and the reader only ever sees CODES. The first version of this
      // said "X has no BAG conversion ... against a line reporting in BAG" —
      // the same word twice, which reads as nonsense and sent somebody looking
      // for a missing package that was right there.
      //
      // The two causes are genuinely different problems:
      //
      //   SAME CODE, DIFFERENT ID   a master-data mismatch. The unit exists on
      //                             both sides under two records, and nothing
      //                             here can safely assume they mean the same
      //                             thing — a code is a label, an id is the key.
      //   NO SUCH CODE              a real absence. The SKU is simply not
      //                             counted in the unit the line reports in.
      //
      // Both are refused, because converting on a code match would be assuming
      // exactly the equivalence master data declines to state. Only the wording
      // differs, and it is the difference between a five-minute fix and an hour.
      const sameCode = product.packages.find((pkg) => pkg.uom?.code === targetUomCode);
      const counted = product.packages
        .map((pkg) => pkg.uom?.code)
        .filter((code): code is string => code !== undefined && code !== null);

      throw new HTTPException(400, {
        message:
          sameCode?.uom == null
            ? `${product.name} is counted in ${counted.length === 0 ? "no unit master data knows about" : counted.join(", ")}, and this line reports in ${targetUomCode}. There is no conversion between them.`
            : `${product.name} is counted in ${targetUomCode}, but under unit record ${String(sameCode.uom.id)} where this line reports unit record ${String(targetUomId)}. The codes match and the records do not, which is a master-data mismatch rather than a missing conversion.`,
      });
    }

    // THE IDENTITY IS MADE EXACT HERE, not merely likely. When the operator
    // entered in the line's own unit the two factors are the same package's, so
    // they are equal by construction — but taking `target.factorToBase` for both
    // is what guarantees the ratio is exactly 1 rather than tripping on two
    // independently rounded reads of the same number.
    //
    // BY CODE, matching the target lookup above: "BAG entered against a line
    // reporting in BAG" is an identity whether or not the two records share an id.
    const sameUnit = sameUnitCode(entered.uom.code, targetUomCode);
    const enteredFactor = sameUnit ? target.factorToBase : entered.factorToBase;

    // The base is whichever package upstream marks `main`; every factor points at
    // it. Falling back to the target package keeps the row's base columns
    // populated when no package is flagged — they are provenance, not arithmetic.
    const base = product.packages.find((pkg) => pkg.main) ?? target;

    return {
      productName: product.name,
      productCode: product.code,
      // DOWNGRADED WHEN ONLY THE CODE MATCHED. The quantity is recorded, and the
      // row says the unit was not confirmed against a shared record — which is
      // the honest middle between refusing a legitimate entry and claiming a
      // check that did not happen.
      unitCheck: byId === undefined ? "unverified" : unitCheck,
      units: {
        enteredUomId: entered.uom.id,
        enteredUomCode: entered.uom.code,
        enteredUomName: entered.uom.name,
        enteredFactorToBase: enteredFactor,
        targetUomId,
        targetUomCode,
        targetUomName: target.uom?.name ?? null,
        targetFactorToBase: target.factorToBase,
        baseUomId: base.uom?.id ?? targetUomId,
        baseUomCode: base.uom?.code ?? targetUomCode,
      },
    };
  }

  // The reason's labels, snapshotted. Stored as NAME as well as id because the
  // catalogue is another service's and a report read months later must still be
  // able to say what the operator picked, whatever upstream has done since.
  private async resolveReason(workCenterId: number, reasonId: number) {
    const reasons = await this.masterData.listRejectReasons(workCenterId);
    const reason = reasons.find((r) => r.id === reasonId);
    if (reason === undefined) {
      // SCOPED, so this also refuses a reason belonging to a different line —
      // which is the whole point of the filter added upstream. An unscoped
      // catalogue would let a reject on one line be filed under another's reason,
      // and the reason is what the Quality Pareto groups on.
      throw new HTTPException(400, {
        message: "that reason is not in this line's catalogue",
      });
    }
    return reason;
  }

  // A LABEL ONLY. The machine does not change where the quantity lands — see
  // 0017's column comment. Resolved so the trail can name it without a second
  // service being up months later.
  private async resolveWorkUnitName(
    workCenterId: number,
    input: CreateQualityEntryInput,
  ): Promise<string | null> {
    if (input.kind !== "reject") return null;

    const roster = await this.masterData.listWorkUnitIds(
      workCenterId,
      "resolve the line's machines",
    );
    if (!roster.some((unit) => unit.id === input.workUnitId)) {
      throw new HTTPException(400, { message: "that machine is not on this line" });
    }

    // SNAPSHOTTED FROM GOLD. The roster carries ids only, so the name comes from
    // oee.work_unit_shift_reports, which denormalises it NOT NULL — no upstream
    // call on a write path.
    //
    // This returned NULL, on the reasoning that a name is a nicety. The activity
    // feed's fallback is `machine ${id}`, so every entry read "machine 3": a
    // trail that names the operator and then identifies the machine by a
    // database id is not one a supervisor can read.
    return await this.repo.findWorkUnitName(input.workUnitId, workCenterId);
  }
}

// TWO UNIT CODES, COMPARED THE WAY A HUMAN WOULD. Trimmed and case-insensitive,
// because 'BAG', 'Bag' and 'bag ' are one unit written three ways and no operator
// would call them different.
//
// It is deliberately NOT a general equivalence: it says nothing about 'BAG' and
// 'BAGS', and nothing about two units that genuinely differ. It exists so that a
// unit's CODE identifies it here as it already does in every aggregate.
function sameUnitCode(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export { QualityEntryService };
export type { QualityEntryServiceDeps, QualityEntryTotal };
