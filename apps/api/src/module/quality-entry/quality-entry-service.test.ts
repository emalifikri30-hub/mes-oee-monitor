import { describe, expect, it, vi } from "vite-plus/test";

import { QualityEntryService } from "./quality-entry-service.js";

// The shift WINDOW is Postgres's arithmetic (shared/shift-window.ts runs it in
// SQL so the zone rules live in one place), and none of it is under test here —
// these are about the unit conversion. Stubbed so the service needs no database.
vi.mock("../../shared/shift-window.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/shift-window.js")>()),
  resolveShiftWindow: vi.fn().mockResolvedValue({
    from: new Date("2026-08-01T00:00:00Z"),
    to: new Date("2026-08-01T08:00:00Z"),
  }),
}));

// THE CONVERSION, and mostly one case: BAG TO BAG MUST NEVER REFUSE.
//
// It did. The target package was matched on uom **ID** alone, so whenever Gold and
// master data held one unit under two records the service answered
//
//   "SKU B has no BAG conversion ... against a line reporting in BAG"
//
// — the same word twice, refusing an entry that any operator would call trivial.
// A code is what every screen shows and what every aggregate in
// shared/loss-aggregate.ts already treats as a unit's identity
// (`count(DISTINCT uom_code) = 1`); the conversion path was the outlier for using
// the id.
//
// These pin the resulting rule: the id wins when it matches, the code is the
// fallback, and a code-only match is recorded as `unverified` rather than
// refused or silently blessed.

const LINE_UOM = { id: 41, code: "BAG", name: "Bag" };

// A LINE SHIFT REPORT, as ReportRef spells it. The subject is carried beside the
// grain because "sku" is not a fourth grain — see quality-entry-repository.ts.
const LINE_SHIFT = { subject: "work-center", grain: "shift" } as const;
const SKU_DAY = { subject: "product", grain: "day" } as const;

// The one package every SKU test below needs: master data's BAG, matching the
// line's unit by code, so the conversion is never what fails.
const BAG = [
  { id: 1, main: true, sortOrder: 0, factorToBase: 1, uom: { id: 3, code: "BAG", name: "Bag" } },
];

// A SKU day report's anchor: the same line and window, plus the product the report
// is ABOUT. That extra field is the whole difference between the two subjects here.
const skuAnchor = (productId: number) => ({
  findTargetByReport: vi.fn().mockResolvedValue({
    workCenterId: 9,
    timeZone: "Asia/Jakarta",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-02",
    shift: null,
    productId,
    infeedUomId: LINE_UOM.id,
    infeedUomCode: LINE_UOM.code,
  }),
});

function setup(
  packages: unknown[],
  over: Record<string, unknown> = {},
  // The freeze's only dependency, overridable because "every machine closed" is
  // the one case a write must refuse and it lives on the other repository.
  machines = { machinesFound: 2, machinesClosed: 0 },
) {
  const insert = vi.fn((row: unknown) => Promise.resolve(row));

  const service = new QualityEntryService({
    qualityEntryRepository: {
      findTargetByReport: vi.fn().mockResolvedValue({
        workCenterId: 9,
        timeZone: "Asia/Jakarta",
        dateFrom: "2026-08-01",
        dateTo: "2026-08-02",
        shift: 1,
        productId: null,
        infeedUomId: LINE_UOM.id,
        infeedUomCode: LINE_UOM.code,
      }),
      // The line reports in BAG under record 41.
      findShiftTarget: vi.fn().mockResolvedValue({
        infeedUomId: LINE_UOM.id,
        infeedUomCode: LINE_UOM.code,
      }),
      findProductAtTarget: vi.fn().mockResolvedValue(undefined),
      // Snapshotted onto the row so the activity feed can name the machine
      // rather than falling back to "machine 3".
      findWorkUnitName: vi.fn().mockResolvedValue("Vertical Packer N"),
      insert,
      ...over,
    },
    // No machines on the line are checked here; the freeze is its own concern.
    workCenterReportWriterRepository: {
      summariseLineShift: vi.fn().mockResolvedValue(machines),
    },
    masterDataService: {
      getProduct: vi.fn().mockResolvedValue({ id: 4, code: "SKU-B", name: "SKU B", packages }),
      listRejectReasons: vi.fn().mockResolvedValue([{ id: 7, code: "R1", name: "Burst seal" }]),
      listWorkUnitIds: vi.fn().mockResolvedValue([{ id: 901 }]),
    },
    // Never touched: resolveShiftWindow is stubbed above and nothing else in this
    // path reaches the database.
    goldDb: undefined,
    operatorRoles: {},
  } as unknown as ConstructorParameters<typeof QualityEntryService>[0]);

  return { service, insert };
}

const draft = {
  kind: "reject" as const,
  productId: 4,
  packageId: 1,
  quantity: 180,
  shift: 1,
  reasonId: 7,
  workUnitId: 901,
  requestId: "00000000-0000-4000-8000-000000000000",
};

const actor = { subject: "kc-1", name: "Operator One", roles: [] };

describe("QualityEntryService — BAG to BAG", () => {
  // THE CASE THAT SHIPPED BROKEN. Master data's BAG is record 3, the line reports
  // BAG under record 41. Same unit, two records — and 180 bags must land as 180.
  it("records 180 BAG against a line reporting BAG under a different record", async () => {
    const { service, insert } = setup([
      {
        id: 1,
        main: true,
        sortOrder: 0,
        factorToBase: 1,
        uom: { id: 3, code: "BAG", name: "Bag" },
      },
    ]);

    await service.create(LINE_SHIFT, 2, draft, actor as never);

    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row?.enteredQty).toBe(180);
    expect(row?.enteredUomCode).toBe("BAG");
    expect(row?.targetUomCode).toBe("BAG");
    // AN IDENTITY: both factors equal, so target_qty is exactly the entered
    // quantity once Postgres computes it.
    expect(row?.enteredFactorToBase).toBe(row?.targetFactorToBase);
  });

  // ...AND IT SAYS SO. The entry is written, and the row records that the unit
  // could not be confirmed against a shared record — the honest middle between
  // refusing a legitimate entry and claiming a check that did not happen.
  it("marks a code-only match unverified", async () => {
    const { service, insert } = setup([
      {
        id: 1,
        main: true,
        sortOrder: 0,
        factorToBase: 1,
        uom: { id: 3, code: "BAG", name: "Bag" },
      },
    ]);

    await service.create(LINE_SHIFT, 2, draft, actor as never);

    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row?.unitCheck).toBe("unverified");
  });

  // THE CLEAN CASE MUST NOT CHANGE. When the ids agree the match is exact and the
  // row is verified — the fallback above is a fallback, not the new normal.
  it("stays verified when the records agree", async () => {
    const { service, insert } = setup([
      {
        id: 1,
        main: true,
        sortOrder: 0,
        factorToBase: 1,
        uom: { id: LINE_UOM.id, code: "BAG", name: "Bag" },
      },
    ]);

    await service.create(LINE_SHIFT, 2, draft, actor as never);

    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row?.unitCheck).toBe("verified");
  });

  // Case and whitespace are one unit written three ways; no operator would call
  // them different.
  it("treats 'bag ' and 'BAG' as one unit", async () => {
    const { service, insert } = setup([
      {
        id: 1,
        main: true,
        sortOrder: 0,
        factorToBase: 1,
        uom: { id: 3, code: "bag ", name: "Bag" },
      },
    ]);

    await service.create(LINE_SHIFT, 2, draft, actor as never);

    expect(insert).toHaveBeenCalled();
  });

  // AND A GENUINELY DIFFERENT UNIT IS STILL REFUSED. The fallback is a code
  // match, not a shrug: converting PCS into BAG without a factor is the silent
  // wrong number this whole feature is built to avoid.
  it("still refuses a SKU with no route to the line's unit", async () => {
    const { service } = setup([
      {
        id: 1,
        main: true,
        sortOrder: 0,
        factorToBase: 1,
        uom: { id: 5, code: "PCS", name: "Piece" },
      },
    ]);

    await expect(service.create(LINE_SHIFT, 2, draft, actor as never)).rejects.toThrow(/PCS/);
  });
});

// ---------------------------------------------------------------------------
// The SKU day report — one extra key part, and it is not the client's to choose
// ---------------------------------------------------------------------------
//
// A SKU report supplies the line, the business date AND the product; the operator
// supplies only the shift. The product is the new thing, and the guard on it is
// resolveBusinessDate's rule applied one field over: a mismatch means the screen
// and the server disagree about what is on display, and correcting it silently
// hides that.
//
// Rebasing to the report's product instead of refusing would be worse than
// cosmetic: product_id is the CONVERSION BASIS (0017's ck_wcqe_basis), so the
// quantity would be converted through a different product's packages[] and a
// plausible wrong number written into an append-only ledger the pipeline applies.
describe("QualityEntryService — a SKU day report", () => {
  it("records the entry against the report's own product", async () => {
    const { service, insert } = setup(BAG, skuAnchor(4));

    await service.create(SKU_DAY, 79, draft, actor as never);

    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row?.productId).toBe(4);
    // Still ONE shift-keyed row, from a screen that spans three: the operator's
    // named shift, and the report's own business date.
    expect(row?.shift).toBe(1);
    expect(row?.businessDate).toBe("2026-08-01");
  });

  it("refuses a product the report is not about, naming both", async () => {
    const { service, insert } = setup(BAG, skuAnchor(4));

    await expect(
      service.create(SKU_DAY, 79, { ...draft, productId: 5 }, actor as never),
    ).rejects.toThrow(/covers product 4, not 5/);
    expect(insert).not.toHaveBeenCalled();
  });

  // A LINE report has no product dimension at all, so the client's choice stands.
  // This is the shipped behaviour and the guard must not touch it.
  it("leaves a line report's product entirely to the client", async () => {
    const { service, insert } = setup(BAG);

    await service.create(LINE_SHIFT, 2, { ...draft, productId: 5 }, actor as never);

    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row?.productId).toBe(5);
  });

  // resolveBusinessDate NEEDS NO SKU ARM, and this is the assertion that says so.
  // oee.product_report_wc_day is a DAY table, so the SKU ref carries grain "day"
  // and the existing `grain !== "month"` branch is already correct about it. That
  // is the payoff of ReportRef over a fourth grain literal, stated as a test.
  it("refuses a business date the report does not cover, through the day arm", async () => {
    const { service } = setup(BAG, skuAnchor(4));

    await expect(
      service.create(SKU_DAY, 79, { ...draft, businessDate: "2026-08-02" }, actor as never),
    ).rejects.toThrow(/covers 2026-08-01/);
  });

  // THE FREEZE IS THE SAME QUESTION, ASKED THE SAME WAY. A SKU has no approval and
  // can never have one; what is frozen is the machine shift reports whose numbers
  // the entry moves, and asking summariseLineShift keeps ONE definition of
  // "approved" in the app.
  it("is frozen by the line shift the entry lands on", async () => {
    const { service, insert } = setup(BAG, skuAnchor(4), {
      machinesFound: 2,
      machinesClosed: 2,
    });

    await expect(service.create(SKU_DAY, 79, draft, actor as never)).rejects.toThrow(
      /has been approved/,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  // A PARTIALLY approved line stays editable, matching the line screens and
  // useReportApproved: some machine on it is still open, so the shift is not
  // signed off.
  it("is not frozen while any machine on that shift is still open", async () => {
    const { service, insert } = setup(BAG, skuAnchor(4), {
      machinesFound: 2,
      machinesClosed: 1,
    });

    await service.create(SKU_DAY, 79, draft, actor as never);

    expect(insert).toHaveBeenCalled();
  });

  // The ledger a SKU report reads is ITS OWN SKU's, which is what stops the card
  // rendering another product's entries under this report's Reject tile.
  it("narrows the ledger to the report's product", async () => {
    const listForTarget = vi.fn().mockResolvedValue([]);
    const totalsForTarget = vi.fn().mockResolvedValue([]);
    const { service } = setup(BAG, { ...skuAnchor(4), listForTarget, totalsForTarget });

    await service.list(SKU_DAY, 79, false);

    expect(listForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workCenterId: 9, shift: null, productId: 4 }),
      false,
    );
    expect(totalsForTarget).toHaveBeenCalledWith(expect.objectContaining({ productId: 4 }));
  });

  it("leaves a line report's ledger unnarrowed", async () => {
    const listForTarget = vi.fn().mockResolvedValue([]);
    const totalsForTarget = vi.fn().mockResolvedValue([]);
    const { service } = setup(BAG, { listForTarget, totalsForTarget });

    await service.list(LINE_SHIFT, 2, false);

    expect(listForTarget).toHaveBeenCalledWith(expect.objectContaining({ productId: null }), false);
  });
});
