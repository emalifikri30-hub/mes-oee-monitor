import { describe, expect, it, vi } from "vite-plus/test";

import { ProductReportService } from "./product-report-service.js";

import type { ProductReportReader } from "./product-report-repository.js";

const REPORT = {
  id: 42,
  grain: "day" as const,
  businessDate: "2026-08-19",
  timeZone: "Asia/Jakarta",
  workCenterId: 3,
  productId: 7,
};

// THE REPORT IS WRAPPED, so that "the repository found nothing" is representable.
// `setup(report: unknown = REPORT)` cannot express it: passing `undefined`
// selects the DEFAULT, so the 404 test called the happy path and passed by
// resolving. Caught by the assertion failing, which is the good case — a weaker
// test would have gone green.
function setup(
  opts: {
    report?: unknown;
    downtime?: { entries: unknown[]; totalMembers: number; trackedMembers: number };
    quality?: unknown[];
  } = {},
) {
  const { downtime, quality } = opts;
  // `"report" in opts`, NOT `opts.report ?? REPORT`. The 404 test passes
  // `{ report: undefined }` deliberately — an id that names nothing — and a
  // nullish default would swallow it and hand back a populated report, turning an
  // assertion about a 404 into one that never runs.
  const getReport = vi.fn().mockResolvedValue("report" in opts ? opts.report : REPORT);
  const aggregateRejectReasons = vi.fn().mockResolvedValue({ buckets: [], totalQuantity: 0 });
  const aggregateDowntimeEventReasons = vi.fn().mockResolvedValue({ buckets: [] });
  const countUnattributedDowntime = vi.fn().mockResolvedValue({ unattributed: 4 });
  const paginateReport = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
  const listDowntimeEdits = vi
    .fn()
    .mockResolvedValue(downtime ?? { entries: [], totalMembers: 0, trackedMembers: 0 });
  const listMachineRoster = vi.fn().mockResolvedValue({ machines: [] });
  const listActivityForTarget = vi.fn().mockResolvedValue(quality ?? []);

  const repo = {
    getReport,
    aggregateRejectReasons,
    aggregateDowntimeEventReasons,
    countUnattributedDowntime,
    paginateReport,
    listDowntimeEdits,
    listMachineRoster,
  } as unknown as ProductReportReader;

  // Two things read the real Gold handle directly: getWatermark, and — since the
  // Machine picker landed — resolveReportWindow, which resolves the day's instants
  // with AT TIME ZONE in Postgres.
  //
  // THE STUB HAS TO ROUTE, and returning `[]` for everything is not enough.
  // resolveReportWindow THROWS on an empty result rather than handing back an
  // undefined bound ("a silent undefined here becomes a NaN-width window"), so a
  // flat stub turns every getMachines assertion into one about that error. The
  // watermark's own behaviour is still covered where it lives.
  const goldDb = ((chunks: TemplateStringsArray) =>
    Promise.resolve(
      chunks.join("").includes("AT TIME ZONE")
        ? [{ from: new Date("2026-08-19T00:00:00.000Z"), to: new Date("2026-08-20T00:00:00.000Z") }]
        : [],
    )) as never;

  return {
    service: new ProductReportService({
      productReportReaderRepository: repo,
      qualityEntryRepository: { listActivityForTarget } as never,
      goldDb,
      // `withLog` is silent on success and calls
      // `logger.withMetadata({...}).error(event)` on failure, so the stub has to
      // be CHAINABLE. A flat { error } passes every happy-path test in this file
      // and then throws "withMetadata is not a function" from inside the 404
      // path — turning an assertion about a 404 into one about a TypeError.
      logger: { withMetadata: () => ({ error: vi.fn() }) } as never,
    }),
    getReport,
    aggregateRejectReasons,
    aggregateDowntimeEventReasons,
    countUnattributedDowntime,
    listDowntimeEdits,
    listMachineRoster,
    listActivityForTarget,
  };
}

describe("ProductReportService.getReport", () => {
  it("404s on an id that names nothing", async () => {
    const { service } = setup({ report: undefined });

    await expect(service.getReport(42)).rejects.toMatchObject({ status: 404 });
  });
});

// THE WINDOW IS TAKEN FROM THE ROW, NOT FROM THE REQUEST, and that is what makes
// a SKU read un-spoofable. A `?productId=` on these routes would let a caller ask
// for SKU B's rejects against SKU A's report and get a coherent-looking answer —
// right line, right date, wrong SKU, nothing to notice.
describe("ProductReportService — the sub-resource window", () => {
  it("scopes the reject read to the report row's own line and SKU", async () => {
    const { service, aggregateRejectReasons } = setup();

    await service.getRejectReasons(42);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(
      expect.objectContaining({ workCenterId: 3, productId: 7 }),
    );
  });

  // Half-open, one day wide. The source tables are SHIFT-keyed, so a zero-width
  // range would match nothing and every card would render empty.
  it("spans exactly one day, exclusive at the end", async () => {
    const { service, aggregateRejectReasons } = setup();

    await service.getRejectReasons(42);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: "2026-08-19", dateTo: "2026-08-20" }),
    );
  });

  // NULL, not a shift number. A SKU day report spans all three shifts and the
  // source tables are shift-keyed — passing a shift here would silently report a
  // third of the day, with every figure on screen internally consistent.
  it("passes no shift, so the read widens over all three", async () => {
    const { service, aggregateRejectReasons } = setup();

    await service.getRejectReasons(42);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(expect.objectContaining({ shift: null }));
  });

  it("crosses a month boundary correctly", async () => {
    const { service, aggregateRejectReasons } = setup({
      report: { ...REPORT, businessDate: "2026-08-31" },
    });

    await service.getRejectReasons(42);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: "2026-08-31", dateTo: "2026-09-01" }),
    );
  });
});

// The count travels WITH the buckets rather than being a separate call a caller
// may forget. With downtime_reports.product_id unwritten — the live state — a SKU
// report otherwise reads Availability 100% with an empty downtime table, which is
// a plausible screen rather than an error.
describe("ProductReportService.getDowntimeEventReasons", () => {
  it("returns the unattributed count alongside the buckets", async () => {
    const { service } = setup();

    const out = await service.getDowntimeEventReasons(42);

    expect(out.unattributed).toBe(4);
    expect(out.timeZone).toBe("Asia/Jakarta");
  });

  it("counts the unattributed stops over the same window as the buckets", async () => {
    const { service, aggregateDowntimeEventReasons, countUnattributedDowntime } = setup();

    await service.getDowntimeEventReasons(42);

    expect(countUnattributedDowntime.mock.calls[0]?.[0]).toEqual(
      aggregateDowntimeEventReasons.mock.calls[0]?.[0],
    );
  });
});

// ---------------------------------------------------------------------------
// The Log Activity panel — TWO live arms and a NAMED third absence
// ---------------------------------------------------------------------------
//
// TODOS.md §65 left "decide what a SKU feed contains before building one" open.
// The decision is asserted here rather than only commented, because the part that
// could regress silently is the SHAPE of the answer: an approval arm that grew
// entries, or an unattributed residual that stopped travelling with the payload,
// would both render a plausible panel.
const EDIT = {
  kind: "downtime" as const,
  id: "downtime:1",
  at: new Date("2026-08-19T09:00:00.000Z"),
  by: "kc-1",
  sourceEventId: "evt-1",
  field: "category",
  oldValue: "PLANNED",
  newValue: "UNPLANNED",
  workUnitId: 5,
  workUnitName: "Vertical Packer",
};

const ENTRY = {
  id: 7,
  kind: "reject" as const,
  shift: 2,
  productName: "SKU A",
  reasonName: "Burst seal",
  enteredQty: 10,
  enteredUomCode: "CTN",
  targetQty: 120,
  targetUomCode: "BAG",
  unitCheck: "verified",
  enteredAt: "2026-08-19T12:00:00.000Z",
  enteredBy: "kc-2",
  enteredByName: "Operator Two",
  voidedAt: null,
  voidedBy: null,
  voidedByName: null,
  voidReason: null,
};

describe("ProductReportService.getActivity", () => {
  it("merges both arms, newest first", async () => {
    const { service } = setup({
      downtime: { entries: [EDIT], totalMembers: 3, trackedMembers: 3 },
      quality: [ENTRY],
    });

    const feed = await service.getActivity(79);

    // The entry is at 12:00 and the edit at 09:00, and the two arms arrive in
    // separate lists — so an unsorted merge would put the edit first.
    expect(feed.entries.map((e) => e.kind)).toEqual(["quality", "downtime"]);
  });

  // ASSERTED AS AN ABSENCE, not as a length. `sources` has three entries and
  // `entries` can never have an approval among them, and those are two different
  // claims: ProductActivityEntry has no approval arm to construct, while the
  // source list names the absence so a reader who expects approvals is answered.
  it("names the approval arm as not applicable and never emits one as an entry", async () => {
    const { service } = setup({
      downtime: { entries: [EDIT], totalMembers: 1, trackedMembers: 1 },
      quality: [ENTRY],
    });

    const feed = await service.getActivity(79);

    expect(feed.sources).toHaveLength(3);
    expect(feed.sources.find((s) => s.kind === "approval")).toMatchObject({
      tracked: false,
      untrackedReason: "not-applicable",
      totalMembers: 0,
    });
    // AND THE COMPILER PROVES THE OTHER HALF, more strongly than a runtime check
    // could: `e.kind === "approval"` here is a TS2367 error, because
    // ProductActivityEntry has no such arm and the comparison has no overlap. So
    // what is asserted at runtime is the positive form — these two kinds and no
    // others — and the impossibility of a third is a build error rather than a
    // passing expect.
    expect(new Set(feed.entries.map((e) => e.kind))).toEqual(new Set(["quality", "downtime"]));
  });

  // §65 STEP 3. The downtime arm is narrowed by product, and `product_id = $` is
  // FALSE for NULL rather than unknown-but-included — so an empty panel means
  // either "nobody edited anything" or "no stop on this line belongs to any SKU".
  // This number is the only thing that separates them.
  it("carries the unattributed residual onto the payload", async () => {
    const { service } = setup();

    const feed = await service.getActivity(79);

    expect(feed.unattributed).toBe(4);
  });

  // ZERO MEMBERS IS NOT AN UNTRACKED ARM. "These downtime records carry no stable
  // identifier" is a claim about records that do not exist; the line feed makes it
  // and this one deliberately does not.
  it("reports an empty downtime window as tracked, not as untracked", async () => {
    const { service } = setup({
      downtime: { entries: [], totalMembers: 0, trackedMembers: 0 },
    });

    const source = (await service.getActivity(79)).sources.find((s) => s.kind === "downtime");

    expect(source).toMatchObject({ tracked: true, untrackedReason: null });
  });

  // ...BUT A WINDOW WITH STOPS THAT CANNOT CARRY A TRAIL STILL SAYS SO. That is
  // the case the reason exists for, and it must not be lost with the change above.
  it("reports stops with no stable id as untracked", async () => {
    const { service } = setup({
      downtime: { entries: [], totalMembers: 3, trackedMembers: 0 },
    });

    const source = (await service.getActivity(79)).sources.find((s) => s.kind === "downtime");

    expect(source).toMatchObject({ tracked: false, untrackedReason: "no-stable-id" });
  });

  // ZERO IS A REAL ANSWER for the quality arm — no reject was entered by hand for
  // this SKU — where `quality.length > 0` would report a quiet day as an
  // unimplemented feature. This service owns the write, so the arm is always
  // tracked.
  it("keeps the quality arm tracked even with no entries", async () => {
    const { service } = setup({ quality: [] });

    const source = (await service.getActivity(79)).sources.find((s) => s.kind === "quality");

    expect(source).toMatchObject({ tracked: true, untrackedReason: null, totalMembers: 0 });
  });

  // THE FEED IS THIS SKU's, over ALL THREE SHIFTS. A shift-keyed read would report
  // a third of the day; an unnarrowed one would report the whole line's.
  it("reads the ledger over the whole day and narrowed to the report's SKU", async () => {
    const { service, listActivityForTarget } = setup();

    await service.getActivity(79);

    expect(listActivityForTarget).toHaveBeenCalledWith({
      workCenterId: 3,
      dateFrom: "2026-08-19",
      dateTo: "2026-08-20",
      shift: null,
      productId: 7,
    });
  });

  // A VOID IS SHOWN, NOT HIDDEN. The ledger answers "what counts" and the feed
  // answers "what happened" — a trail that dropped the retraction would show the
  // 500 and not the correction.
  it("surfaces a voided entry rather than dropping it", async () => {
    const { service } = setup({
      quality: [{ ...ENTRY, voidedAt: "2026-08-19T13:00:00.000Z", voidedBy: "kc-3" }],
    });

    const entry = (await service.getActivity(79)).entries[0];

    expect(entry).toMatchObject({ kind: "quality", voidedAt: "2026-08-19T13:00:00.000Z" });
  });

  // WHICH SHIFT, which the line's feed does not carry at all. A SKU day spans
  // three shifts and a rework names no machine, so without this two entries read
  // as two entries about the same thing.
  it("labels a quality entry with its shift", async () => {
    const { service } = setup({ quality: [ENTRY] });

    expect((await service.getActivity(79)).entries[0]).toMatchObject({ shift: 2 });
  });

  it("404s on an id that names nothing", async () => {
    const { service } = setup({ report: undefined });

    await expect(service.getActivity(42)).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// The reject dialog's Machine picker
// ---------------------------------------------------------------------------
describe("ProductReportService.getMachines", () => {
  // SCOPED ON INSTANTS, because oee.work_unit_shift_reports keys on `date` — the
  // instant a shift started — and its business_date is nullable and unbackfilled
  // (§46). A date predicate would return an empty roster and the picker would
  // offer nothing, which reads as a line with no machines.
  it("resolves the day's instants and scopes the roster by the line", async () => {
    const { service, listMachineRoster } = setup();

    await service.getMachines(79);

    expect(listMachineRoster).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }),
      3,
    );
  });

  it("404s on an id that names nothing", async () => {
    const { service } = setup({ report: undefined });

    await expect(service.getMachines(42)).rejects.toMatchObject({ status: 404 });
  });
});
