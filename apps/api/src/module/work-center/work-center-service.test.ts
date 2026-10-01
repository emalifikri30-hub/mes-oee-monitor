import { describe, expect, it, vi } from "vite-plus/test";

import { WorkCenterReportService } from "./work-center-service.js";

import type { WorkCenterReportReader } from "./work-center-repository.js";

function setup(items: unknown[] = [], totalElements = 0, report?: unknown) {
  const paginateReport = vi.fn().mockResolvedValue({ items, totalElements });
  const getReport = vi.fn().mockResolvedValue(report);
  const repo = { paginateReport, getReport } as unknown as WorkCenterReportReader;
  const listWorkUnitIds = vi.fn().mockResolvedValue([]);
  return {
    service: new WorkCenterReportService({
      workCenterReportReaderRepository: repo,
      ...cascadeDeps(listWorkUnitIds),
    }),
    paginateReport,
    getReport,
    listWorkUnitIds,
  };
}

// The cascade's collaborators, stubbed.
//
// This module gained a writer and a master-data client for the line APPROVAL, and
// the read tests below assert that neither is touched — which is what keeps the
// "no upstream call on a read" claim in work-center-service.ts checkable rather
// than merely written down.
function cascadeDeps(listWorkUnitIds: ReturnType<typeof vi.fn>) {
  return {
    workCenterReportWriterRepository: {
      closeLineShift: vi.fn(),
      reopenLineShift: vi.fn(),
      summariseLineShift: vi.fn().mockResolvedValue({ machinesFound: 0, machinesClosed: 0 }),
    },
    // Part 3's third feed arm. Empty here — these tests are about the cascade,
    // and an arm that returned rows would put them in every assertion below.
    qualityEntryRepository: { listActivity: vi.fn().mockResolvedValue([]) },
    masterDataService: { listWorkUnitIds },
    operatorRoles: {},
    goldDb: undefined,
  } as unknown as Omit<
    ConstructorParameters<typeof WorkCenterReportService>[0],
    "workCenterReportReaderRepository"
  >;
}

// One ledger row, as the repository hands it over. 10 CTN -> 120 BAG, so a
// mapper that dropped either quantity or swapped the two units fails visibly.
function qualityEntry(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: "reject",
    enteredAt: "2026-08-01T02:00:00.000Z",
    enteredBy: "kc-1",
    enteredByName: "Operator One",
    enteredQty: 10,
    enteredUomCode: "CTN",
    targetQty: 120,
    targetUomCode: "BAG",
    productName: "Kacang Garuda 20g",
    reasonName: "Burst seal",
    workUnitId: 901,
    workUnitName: "Filler 2",
    shift: 2,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    ...over,
  };
}

describe("WorkCenterReportService", () => {
  it("translates page and size into limit and offset", async () => {
    const { service, paginateReport } = setup();

    await service.getPagedReport("day", 3, 25, {});

    expect(paginateReport).toHaveBeenCalledWith(
      expect.objectContaining({ grain: "day", limit: 25, offset: 50 }),
    );
  });

  it("forwards the grain it was asked for", async () => {
    for (const grain of ["shift", "day", "month"] as const) {
      const { service, paginateReport } = setup();
      await service.getPagedReport(grain, 1, 10, {});
      expect(paginateReport.mock.calls[0]?.[0].grain).toBe(grain);
    }
  });

  it("builds the page meta from the repository's total", async () => {
    const { service } = setup([{ id: 1 }], 42);

    const out = await service.getPagedReport("day", 2, 10, {});

    expect(out.meta).toMatchObject({ page: 2, size: 10, totalElements: 42, totalPages: 5 });
  });

  // THE POINT OF THE WHOLE SERVICE, asserted rather than described.
  //
  // The work_unit list resolves a workCenterId into machine ids upstream (fatal on
  // failure) and enriches labels upstream afterwards (degrading). Both stages are
  // gone here because work_center_id is the grain key and the labels are columns.
  // A masterDataClient appearing in these deps is the regression this catches.
  it("has no upstream dependency at all — the filter reaches SQL untouched", async () => {
    const { service, paginateReport } = setup();

    await service.getPagedReport("day", 1, 10, { workCenterId: 999, month: 8, year: 2026 });

    expect(paginateReport).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { workCenterId: 999, month: 8, year: 2026 } }),
    );
  });

  // An unknown line answers 200 with an empty page, NOT 404. The work_unit lists'
  // 404 guards a failure mode of the ID-LIST mechanism — an empty list being
  // dropped as "no filter" and returning every machine's rows. There is no id list
  // here, so there is nothing to guard and no special case to write.
  it("returns an empty page for an unknown work center rather than throwing", async () => {
    const { service } = setup([], 0);

    const out = await service.getPagedReport("day", 1, 10, { workCenterId: 999 });

    expect(out.items).toEqual([]);
    expect(out.meta.totalElements).toBe(0);
  });

  // NULL rates and a NULL roster are real values on these tables. A coalesce
  // creeping in anywhere would claim a perfect line, or a complete one.
  it("passes NULL rates and a NULL expected count straight through", async () => {
    const row = { id: 1, oee: null, availability: null, expectedWorkUnitCount: null };
    const { service } = setup([row], 1);

    const out = await service.getPagedReport("day", 1, 10, {});

    expect(out.items[0]).toEqual(row);
  });

  // -------------------------------------------------------------------------
  // The detail read
  // -------------------------------------------------------------------------

  it("forwards the grain and the id to the repository", async () => {
    for (const grain of ["shift", "day", "month"] as const) {
      const { service, getReport } = setup([], 0, { id: 7 });
      await service.getReport(grain, 7);
      expect(getReport).toHaveBeenCalledWith(grain, 7);
    }
  });

  // 404, WHERE THE LIST ANSWERS 200-EMPTY. Not an inconsistency: a list request
  // names a filter and an unknown line honestly matches nothing, but a detail
  // request names ONE row. Answering 200 with a null body would render an empty
  // report page instead of the browser's not-found state, and the reader would be
  // looking at a screen that says the line produced nothing.
  it("throws 404 when the id names nothing", async () => {
    const { service } = setup([], 0, undefined);

    await expect(service.getReport("shift", 999)).rejects.toMatchObject({ status: 404 });
  });

  // STILL NO UPSTREAM CALL on the detail path — every field the screen needs is a
  // column (0014/0015). The one thing that would have needed mes-master-data, the
  // approval summary, is a separate route precisely so this stays true: the
  // browser AWAITS this request, and the roster is not cached.
  it("returns the row untouched, making no upstream call", async () => {
    const row = { id: 7, lineOut: null, infeedUomName: "BAG", outputUomName: "CARTON" };
    const { service } = setup([], 0, row);

    expect(await service.getReport("shift", 7)).toEqual(row);
  });
});

// ---------------------------------------------------------------------------
// The line approval — one click, N machine shift reports
// ---------------------------------------------------------------------------
//
// WHAT THESE TESTS ARE FOR. Every failure mode of a cascade is quiet. It reports
// a count, and a count that is wrong by one looks exactly like a count that is
// right — so the assertions are about ORDER (what runs before what), IDENTITY
// (which rows the window covers), and the three outcomes, rather than about the
// number coming back non-zero.
//
// The window is a HALF-OPEN [from, to). The one thing that must never regress is
// the shape of that predicate: an equality match on the shift's start instant
// SKIPS a machine row written a millisecond off and approves a subset, answering
// 200 with a summary nothing on screen can question.

const LINE_REPORT = {
  id: 7,
  grain: "shift" as const,
  shift: 2,
  businessDate: "2026-08-09",
  timeZone: "Asia/Jakarta",
  workCenterId: 11,
  workUnitCount: 3,
};

const ACTOR = { subject: "kc-sub-1", name: "dewi", roles: [] as string[] };

const WINDOW = {
  from: new Date("2026-08-09T08:00:00.000Z"),
  to: new Date("2026-08-09T16:00:00.000Z"),
};

// Records the ORDER of everything the cascade does, which is what two of the
// assertions below are actually about — the roster call must land before the
// transaction opens, and the gate must land before either.
function cascadeSetup({
  report = LINE_REPORT as unknown,
  machines = [{ id: 901 }, { id: 902 }, { id: 903 }],
  summary = { machinesFound: 3, machinesClosed: 0 },
  closed = { machinesFound: 3, machinesClosed: 3 },
  reopened = { machinesFound: 3, machinesClosed: 0 },
  roles = {},
  transitions = [] as unknown[],
  downtime = { entries: [] as unknown[], totalMembers: 0, trackedMembers: 0 },
  // The approval arm's member count, which the FEED reads from the reader rather
  // than from the cascade's own summary — see countMachineReports. Defaults to the
  // same 3 the `summary` above reports, so a test that sets neither sees one
  // consistent line.
  machinesFound = 3,
  // Part 3's third arm. Defaults EMPTY, which is a real answer rather than a
  // stub: no reject was entered by hand on this shift. The `quality` source is
  // asserted `tracked: true` even so — a quiet shift must not read as an
  // unimplemented feature.
  qualityEntries = [] as unknown[],
  categoryEditedAt = null as Date | null,
}: {
  report?: unknown;
  machines?: { id: number }[];
  summary?: { machinesFound: number; machinesClosed: number };
  closed?: { machinesFound: number; machinesClosed: number };
  reopened?: { machinesFound: number; machinesClosed: number };
  roles?: Record<string, string>;
  transitions?: unknown[];
  downtime?: { entries: unknown[]; totalMembers: number; trackedMembers: number };
  machinesFound?: number;
  qualityEntries?: unknown[];
  categoryEditedAt?: Date | null;
} = {}) {
  const order: string[] = [];

  const getReport = vi.fn().mockResolvedValue(report);
  const listWorkUnitIds = vi.fn(async () => {
    order.push("roster");
    return machines;
  });
  const getCategoryEditedAt = vi.fn().mockResolvedValue(categoryEditedAt);
  const summariseLineShift = vi.fn(async () => {
    order.push("summarise");
    return summary;
  });
  // The parameter is declared even though the body ignores it: vi.fn infers a
  // zero-arg tuple otherwise, and `mock.calls[0][0]` then stops type-checking —
  // which is exactly the argument these tests need to inspect.
  const closeLineShift = vi.fn(async (_input: Record<string, unknown>) => {
    order.push("close");
    return closed;
  });
  const reopenLineShift = vi.fn(async (_input: Record<string, unknown>) => {
    order.push("reopen");
    return reopened;
  });

  // BOTH READS, because the feed calls ONE of them at all three grains and a swap
  // is silent: `listActivityForTarget` is the RANGE variant, and `listActivity` is
  // it with the range collapsed to a day and a shift named. The shift-keyed one
  // handed a day report's window returns one shift's entries under a day heading;
  // the range one handed a shift's returns all three shifts' on a shift report.
  // Asserting on only one of them would pass a swap in the other direction.
  const qualityFns = {
    listActivityForTarget: vi.fn().mockResolvedValue(qualityEntries),
    listActivity: vi.fn().mockResolvedValue([]),
  };

  // resolveShiftWindow issues one statement and reads rows[0]; this is the whole
  // of the database from its point of view.
  const goldDb = (() => {
    order.push("window");
    return Promise.resolve([WINDOW]);
  }) as unknown as never;

  const service = new WorkCenterReportService({
    workCenterReportReaderRepository: {
      paginateReport: vi.fn(),
      getReport,
      listApprovalTransitions: vi.fn().mockResolvedValue(transitions),
      countMachineReports: vi.fn().mockResolvedValue(machinesFound),
      listDowntimeEdits: vi.fn().mockResolvedValue(downtime),
      getCategoryEditedAt,
    } as unknown as WorkCenterReportReader,
    workCenterReportWriterRepository: {
      summariseLineShift,
      closeLineShift,
      reopenLineShift,
    },
    qualityEntryRepository: qualityFns,
    masterDataService: { listWorkUnitIds },
    operatorRoles: roles,
    goldDb,
  } as unknown as ConstructorParameters<typeof WorkCenterReportService>[0]);

  return {
    service,
    order,
    getReport,
    listWorkUnitIds,
    getCategoryEditedAt,
    summariseLineShift,
    closeLineShift,
    reopenLineShift,
    quality: qualityFns,
  };
}

describe("WorkCenterReportService — the line approval", () => {
  it("closes the machines on the line and reports the count", async () => {
    const { service, closeLineShift } = cascadeSetup();

    const out = await service.approveLineShift(7, ACTOR);

    expect(out).toEqual({ machinesFound: 3, machinesClosed: 3, workUnitCount: 3 });
    expect(closeLineShift).toHaveBeenCalledWith(
      expect.objectContaining({
        // THE LINE'S ID, not a list of machine ids. Every table the cascade touches
        // carries work_center_id, so there is no roster to resolve — see
        // LineShiftKey for the false premise that had this fetching one.
        workCenterId: 11,
        shift: 2,
        closedBy: "kc-sub-1",
        closedByName: "dewi",
      }),
    );
  });

  // THE WINDOW IS A RANGE, AND THE WRITER GETS BOTH ENDS. The repository turns
  // this into `date >= from AND date < to`; handing it a single instant is what
  // an equality join would need, and that is the silent-subset failure.
  it("hands the writer both ends of a half-open window", async () => {
    const { service, closeLineShift } = cascadeSetup();

    await service.approveLineShift(7, ACTOR);

    expect(closeLineShift.mock.calls[0]?.[0]).toMatchObject({
      from: WINDOW.from,
      to: WINDOW.to,
    });
  });

  // THE ROSTER CALL MUST PRECEDE THE TRANSACTION. Inside db.begin, a hanging
  // mes-master-data holds locks on the approvals primary key and starves the pool,
  // with the symptom appearing on unrelated reads. Asserted by ORDER, because
  // nothing about the types would stop the call being moved.
  it("resolves the roster before opening the write transaction", async () => {
    const { service, order } = cascadeSetup();

    await service.approveLineShift(7, ACTOR);

    expect(order.indexOf("roster")).toBeLessThan(order.indexOf("close"));
  });

  // A 403 must not call upstream, must not open a transaction, and must not emit a
  // transition metric. A refusal is not a conflict.
  it("refuses before touching anything when the role is missing", async () => {
    const { service, listWorkUnitIds, closeLineShift } = cascadeSetup({
      roles: { approveLine: "line-approver" },
    });

    await expect(service.approveLineShift(7, ACTOR)).rejects.toMatchObject({ status: 403 });
    expect(listWorkUnitIds).not.toHaveBeenCalled();
    expect(closeLineShift).not.toHaveBeenCalled();
  });

  it("allows the write when the actor holds the configured role", async () => {
    const { service, closeLineShift } = cascadeSetup({
      roles: { approveLine: "line-approver" },
    });

    await service.approveLineShift(7, { ...ACTOR, roles: ["line-approver"] });

    expect(closeLineShift).toHaveBeenCalled();
  });

  // APPROVE_LINE_ROLE AND APPROVE_ROLE ARE DIFFERENT AUTHORITIES. Closing every
  // machine on a line in one click is not the permission "approve the shift you
  // worked" grants, which is why §34's argument produced a fourth variable rather
  // than a reused one. A regression here is a silent privilege widening.
  it("does not accept the machine approve role in place of the line one", async () => {
    const { service } = cascadeSetup({
      roles: { approve: "approver", approveLine: "line-approver" },
    });

    await expect(
      service.approveLineShift(7, { ...ACTOR, roles: ["approver"] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // `null` rather than `undefined`: a default parameter treats an explicit
  // undefined as absent, so the fixture would come back instead of the miss.
  it("404s when the line report does not exist", async () => {
    const { service } = cascadeSetup({ report: null });

    await expect(service.approveLineShift(7, ACTOR)).rejects.toMatchObject({ status: 404 });
  });

  // NO ROSTER MEANS NO EMPTY-ROSTER CASE. This used to 404 when
  // findAllWorkUnitByWorkCenterId returned nothing, because an empty id list
  // would have become `IN ()` — invalid SQL. Scoping by work_center_id removes both
  // the call and the failure mode: a line whose machines never reported simply has
  // no rows, which the machinesFound === 0 case below already covers.
  it("makes no upstream call at all", async () => {
    const { service, listWorkUnitIds } = cascadeSetup();

    await service.approveLineShift(7, ACTOR);

    expect(listWorkUnitIds).not.toHaveBeenCalled();
  });

  it("404s when the roster resolves but no machine reported that shift", async () => {
    const { service, closeLineShift } = cascadeSetup({
      summary: { machinesFound: 0, machinesClosed: 0 },
    });

    await expect(service.approveLineShift(7, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect(closeLineShift).not.toHaveBeenCalled();
  });

  it("409s when every machine on the line is already approved", async () => {
    const { service, closeLineShift } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 3 },
    });

    await expect(service.approveLineShift(7, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(closeLineShift).not.toHaveBeenCalled();
  });

  // A PARTIALLY APPROVED LINE IS APPROVABLE, and closes only what is open. Reachable
  // the moment somebody approves one machine from the machine screen, and the
  // upsert's `WHERE status = 'open'` is what makes it natural rather than a special
  // case.
  it("approves a partially approved line, closing only the open machines", async () => {
    const { service, closeLineShift } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 2 },
      closed: { machinesFound: 3, machinesClosed: 3 },
    });

    const out = await service.approveLineShift(7, ACTOR);

    expect(closeLineShift).toHaveBeenCalled();
    expect(out).toMatchObject({ machinesFound: 3, machinesClosed: 3 });
  });
});

describe("WorkCenterReportService — reopening a line", () => {
  it("reopens and reports the remaining closed count", async () => {
    const { service, reopenLineShift } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 3 },
    });

    const out = await service.reopenLineShift(7, ACTOR);

    expect(reopenLineShift).toHaveBeenCalled();
    expect(out).toMatchObject({ machinesFound: 3, machinesClosed: 0 });
  });

  // ITS OWN VARIABLE. Withdrawing a whole line's sign-off is not what granting one
  // permits — the same separation §34 makes between APPROVE_ROLE and REOPEN_ROLE,
  // one axis over.
  it("does not accept the line approve role in place of the line reopen role", async () => {
    const { service } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 3 },
      roles: { approveLine: "line-approver", reopenLine: "line-reopener" },
    });

    await expect(
      service.reopenLineShift(7, { ...ACTOR, roles: ["line-approver"] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("409s when no machine on the line is approved", async () => {
    const { service, reopenLineShift } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 0 },
    });

    await expect(service.reopenLineShift(7, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(reopenLineShift).not.toHaveBeenCalled();
  });
});

describe("WorkCenterReportService — the approval summary", () => {
  it("counts the reports that EXIST and carries the line row's own count beside it", async () => {
    const { service } = cascadeSetup({ summary: { machinesFound: 4, machinesClosed: 1 } });

    // The two numbers disagree — the line row says three machines reported, the
    // window finds four — and BOTH are returned. The screen abstains on that
    // disagreement rather than rendering "1 of 4" or "1 of 3"; a fraction it
    // cannot support is a wrong answer, not a smaller one.
    expect(await service.getApprovalSummary(7)).toEqual({
      machinesFound: 4,
      machinesClosed: 1,
      workUnitCount: 3,
    });
  });

  // STILL ITS OWN ROUTE, and the reason narrowed rather than disappeared. It no
  // longer needs the roster — nothing here does — but it still runs two COUNT
  // queries over the machine reports and their approvals, and the browser AWAITS
  // the detail payload while only prefetching this. A scan on the blocking path of
  // every page view for one tile is the thing being avoided; the upstream call was
  // never the only reason.
  it("makes no upstream call either", async () => {
    const { service, listWorkUnitIds } = cascadeSetup();

    await service.getApprovalSummary(7);

    expect(listWorkUnitIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The activity feed
// ---------------------------------------------------------------------------
//
// TODOS §52 PREDICTED THIS WOULD BE EMPTY at line grain, because the approvals
// table is keyed (work_unit_id, date, shift) and a line has no work_unit_id to
// report against. The cascade changed the premise rather than working around it:
// a line approval IS N machine approvals, so its transitions are real events.
// These tests pin the merge and the `sources` reporting, which is what separates
// "nothing happened" from "this arm could never show anything".
describe("WorkCenterReportService — the activity feed", () => {
  const approval = (at: string) => ({
    kind: "approval",
    id: `approval:${at}`,
    at: new Date(at),
    workUnitId: 901,
  });
  const edit = (at: string) => ({
    kind: "downtime",
    id: `downtime:${at}`,
    at: new Date(at),
    workUnitId: 902,
  });

  it("merges both arms newest-first, not grouped by kind", async () => {
    const { service } = cascadeSetup({
      transitions: [approval("2026-08-09T10:00:00Z"), approval("2026-08-09T08:00:00Z")],
      downtime: {
        entries: [edit("2026-08-09T09:00:00Z")],
        totalMembers: 4,
        trackedMembers: 4,
      },
    });

    const out = await service.getActivity("shift", 7);

    expect(out.entries.map((e) => e.id)).toEqual([
      "approval:2026-08-09T10:00:00Z",
      "downtime:2026-08-09T09:00:00Z",
      "approval:2026-08-09T08:00:00Z",
    ]);
  });

  it("echoes the plant zone, because `at` renders as a wall-clock time", async () => {
    const { service } = cascadeSetup();

    expect((await service.getActivity("shift", 7)).timeZone).toBe("Asia/Jakarta");
  });

  // PER-ARM, NOT ONE FLAG FOR THE PAYLOAD. An empty feed is ambiguous, and these
  // three entries are what resolve it: the approval arm is tracked and says how
  // many machines could carry a transition; the downtime arm says how many stops
  // could carry a trail at all; quality has no write path anywhere (§32).
  it("reports what each arm could ever show", async () => {
    const { service } = cascadeSetup({
      summary: { machinesFound: 3, machinesClosed: 1 },
      downtime: { entries: [], totalMembers: 5, trackedMembers: 2 },
      qualityEntries: [qualityEntry()],
    });

    const out = await service.getActivity("shift", 7);

    expect(out.sources).toHaveLength(3);
    expect(out.sources[0]).toMatchObject({ kind: "approval", tracked: true, totalMembers: 3 });
    expect(out.sources[1]).toMatchObject({
      kind: "downtime",
      tracked: true,
      totalMembers: 5,
      trackedMembers: 2,
    });
    // TRACKED SINCE PART 3, where this asserted `tracked: false` with
    // `untrackedReason: "not-implemented"`. That was true and is now wrong: this
    // service owns the write, so every entry carries a full trail and the two
    // counts are equal by construction.
    expect(out.sources[2]).toMatchObject({
      kind: "quality",
      tracked: true,
      untrackedReason: null,
      totalMembers: 1,
      trackedMembers: 1,
    });
  });

  // ZERO IS A REAL ANSWER — no reject was entered by hand on this shift — and it
  // must not read as an unimplemented feature. This is the assertion that stops
  // `tracked` being quietly rewritten as `quality.length > 0`, which looks
  // reasonable and reintroduces exactly the wrong sentence on a quiet shift.
  it("still reports the quality arm as tracked when nothing was entered", async () => {
    const { service } = cascadeSetup({ qualityEntries: [] });

    const out = await service.getActivity("shift", 7);

    expect(out.sources[2]).toMatchObject({
      kind: "quality",
      tracked: true,
      untrackedReason: null,
      totalMembers: 0,
    });
  });

  // BOTH QUANTITIES REACH THE FEED. An operator who typed 10 cartons has to
  // recognise their own entry in a feed otherwise denominated in bags, and the
  // report moved by the converted figure — so a feed carrying only one of them is
  // unreadable to somebody or wrong to everybody.
  it("carries what was typed and what it converted to", async () => {
    const { service } = cascadeSetup({ qualityEntries: [qualityEntry()] });

    const out = await service.getActivity("shift", 7);
    const entry = out.entries.find((e) => e.kind === "quality");

    expect(entry).toMatchObject({
      kind: "quality",
      entryKind: "reject",
      enteredQty: 10,
      enteredUomCode: "CTN",
      targetQty: 120,
      targetUomCode: "BAG",
    });
    // PREFIXED, because three tables with independent bigserials would otherwise
    // collide in React's keying — and the symptom is two entries sharing a row
    // rather than an error.
    expect(entry?.id).toBe("quality-1");
  });

  // A VOID IS AN EVENT. A feed that dropped it would show the 500 and not the
  // retraction, which is the one thing an audit trail exists to prevent.
  it("reports a voided entry rather than hiding it", async () => {
    const { service } = cascadeSetup({
      qualityEntries: [
        qualityEntry({
          voidedAt: "2026-08-01T05:00:00.000Z",
          voidedBy: "kc-2",
          voidReason: "typo",
        }),
      ],
    });

    const out = await service.getActivity("shift", 7);
    const entry = out.entries.find((e) => e.kind === "quality");

    expect(entry?.voidedAt).toEqual(new Date("2026-08-01T05:00:00.000Z"));
    expect(entry?.voidReason).toBe("typo");
    // Ordered on the ENTRY's instant, not the void's: one action, one row.
    expect(entry?.at).toEqual(new Date("2026-08-01T02:00:00.000Z"));
  });

  // A STOP WITH NO source_event_id CANNOT CARRY A TRAIL. Five stops and zero
  // trackable ones is a different statement from "nobody edited anything", and
  // the arm has to make it — otherwise an empty feed reads as a clean shift.
  it("marks the downtime arm untracked when no stop can carry a trail", async () => {
    const { service } = cascadeSetup({
      downtime: { entries: [], totalMembers: 5, trackedMembers: 0 },
    });

    expect((await service.getActivity("shift", 7)).sources[1]).toMatchObject({
      tracked: false,
      untrackedReason: "no-stable-id",
      totalMembers: 5,
    });
  });

  // AND ZERO STOPS IS *NOT* AN UNTRACKED ARM, which is the other half and the one
  // that was wrong on a shipped screen. "These downtime records carry no stable
  // identifier" is a claim about records; with none, the truth is that nothing
  // stopped. TODOS §60 filed it; the coarse grains are what made fixing it cheaper
  // than not, since shipping two new screens with the wrong sentence would have
  // meant two visible copy changes instead of one.
  it("does not call a stopless window untracked", async () => {
    const { service } = cascadeSetup({
      downtime: { entries: [], totalMembers: 0, trackedMembers: 0 },
    });

    expect((await service.getActivity("shift", 7)).sources[1]).toMatchObject({
      kind: "downtime",
      tracked: true,
      untrackedReason: null,
      totalMembers: 0,
    });
  });

  it("404s when the line report does not exist", async () => {
    const { service } = cascadeSetup({ report: null });

    await expect(service.getActivity("shift", 7)).rejects.toMatchObject({ status: 404 });
  });

  // THE MEMBER COUNT COMES FROM THE READER, not from the cascade's summary. It
  // used to read `summariseLineShift`, which the /approval route and both writes
  // also use so a badge and a 409 cannot disagree — a real constraint the FEED has
  // no part in, and one that requires a shift because a cascade does. The feed now
  // counts through the same fragment its approval arm joins against, so the panel
  // cannot report "3 of 12" over a join that looked at 9.
  it("counts the approval arm's members through the reader, not the cascade", async () => {
    const { service, summariseLineShift } = cascadeSetup({
      machinesFound: 12,
      summary: { machinesFound: 3, machinesClosed: 0 },
    });

    const out = await service.getActivity("shift", 7);

    expect(out.sources[0]).toMatchObject({ totalMembers: 12, trackedMembers: 12 });
    expect(summariseLineShift).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The feed at DAY and MONTH grain
// ---------------------------------------------------------------------------
//
// TODOS §60 HELD THESE OPEN ON A PRODUCT QUESTION, not a technical one: a line day
// feed reports ~3N machine-shift transitions, "which may be a log rather than a
// feed". The answer, on the precedent the machine day feed and the area day feed
// both set, is that it is a feed — and what makes the density readable is the
// LABEL rather than the count.
//
// So these tests are about the labels and about WHICH WINDOW each arm asks for,
// because the failure mode here is a panel that renders perfectly over the wrong
// span. Nothing in the payload would look wrong.
describe("WorkCenterReportService — the activity feed at day and month grain", () => {
  const PERIOD_REPORT = {
    id: 9,
    grain: "day" as const,
    // NULL AT THE COARSE GRAINS, and it is the one predicate that differs across
    // the three: it widens the approval join from one shift to three and leaves
    // the quality range unnarrowed.
    shift: null,
    businessDate: "2026-08-01",
    timeZone: "Asia/Jakarta",
    workCenterId: 11,
    workUnitCount: 3,
  };

  function periodSetup(
    over: Record<string, unknown> = {},
    rest: Parameters<typeof cascadeSetup>[0] = {},
  ) {
    return cascadeSetup({ ...rest, report: { ...PERIOD_REPORT, ...over } });
  }

  const transition = (id: number, at: string, shift: number) => ({
    kind: "approval" as const,
    id: `approval:${String(id)}`,
    at: new Date(at),
    workUnitId: 901,
    workUnitName: "Filler 2",
    shift,
  });

  // EVERY SHIFT IN THE RANGE, over the report's own business-date span. With a
  // shift named, a day report's feed would show one shift's entries and read as a
  // quiet day; with the wrong end it drops the last day's silently.
  it.each([
    ["day", "2026-08-02"],
    ["month", "2026-09-01"],
  ] as const)("asks the quality arm for the whole %s, every shift", async (grain, dateTo) => {
    const { service, quality } = periodSetup({ grain });

    await service.getActivity(grain, 9);

    expect(quality.listActivityForTarget).toHaveBeenCalledWith({
      workCenterId: 11,
      dateFrom: "2026-08-01",
      dateTo,
      shift: null,
      // Every SKU on the line: the feed reports what happened on the LINE, and an
      // entry belongs in it whichever product it named.
      productId: null,
    });
    expect(quality.listActivity).not.toHaveBeenCalled();
  });

  // THE RANGE VARIANT AT SHIFT GRAIN TOO, which is the choice worth pinning: one
  // call serves three grains because `resolveLineWindow` already produces a
  // half-open range with the shift beside it. A branch here would be a branch to
  // get backwards.
  it("uses the same range read at shift grain, narrowed by the shift", async () => {
    const { service, quality } = cascadeSetup();

    await service.getActivity("shift", 7);

    expect(quality.listActivityForTarget).toHaveBeenCalledWith({
      workCenterId: 11,
      dateFrom: "2026-08-09",
      dateTo: "2026-08-10",
      shift: 2,
      productId: null,
    });
    expect(quality.listActivity).not.toHaveBeenCalled();
  });

  // BOTH AXES ON ONE ROW, and this is what §60's density objection actually
  // needed. A day feed spans three shifts AND N machines, so neither alone
  // disambiguates a row — the machine was already there, and the shift is what
  // this grain adds.
  it("labels an approval with its machine AND its shift", async () => {
    const { service } = periodSetup(
      {},
      {
        transitions: [
          transition(1, "2026-08-01T10:00:00Z", 1),
          transition(2, "2026-08-01T09:00:00Z", 2),
        ],
      },
    );

    const out = await service.getActivity("day", 9);

    expect(out.entries.map((e) => ("shift" in e ? e.shift : undefined))).toEqual([1, 2]);
    expect(out.entries.map((e) => ("workUnitName" in e ? e.workUnitName : undefined))).toEqual([
      "Filler 2",
      "Filler 2",
    ]);
  });

  // THE QUALITY ARM NEEDS IT MORE THAN THE APPROVAL ONE, because `workUnitId` is
  // null on a rework — so at day grain a rework labelled only by its machine
  // carries no label at all.
  it("labels a quality entry with its shift", async () => {
    const { service } = periodSetup({}, { qualityEntries: [qualityEntry({ shift: 3 })] });

    const out = await service.getActivity("day", 9);

    expect(out.entries.find((e) => e.kind === "quality")).toMatchObject({ shift: 3 });
  });

  // AND NULL AT SHIFT GRAIN, on both arms. A feed covering one shift that labels
  // every row with it is noise, and the browser renders the suffix whenever the
  // field is a number — so this is the assertion that stops the two grains being
  // "made consistent" in the wrong direction.
  it("leaves both arms' shift unlabelled on a line SHIFT report's feed", async () => {
    const { service } = cascadeSetup({
      transitions: [transition(1, "2026-08-09T10:00:00Z", 2)],
      qualityEntries: [qualityEntry({ shift: 2 })],
    });

    const out = await service.getActivity("shift", 7);

    expect(out.entries.find((e) => e.kind === "approval")).toMatchObject({ shift: null });
    expect(out.entries.find((e) => e.kind === "quality")).toMatchObject({ shift: null });
  });

  // ONE TIMELINE, not three arms concatenated — and it matters more here than at
  // shift grain, because the approval arm arrives as ~3N rows spanning three
  // shifts. Without the merge the panel reads as shift 1's whole day, then shift
  // 2's, which looks like a chronology and is not.
  it("merges all three arms by instant across the whole day", async () => {
    const { service } = periodSetup(
      {},
      {
        transitions: [transition(41, "2026-08-01T05:00:00Z", 1)],
        downtime: {
          entries: [{ kind: "downtime", id: "downtime:7", at: new Date("2026-08-01T03:00:00Z") }],
          totalMembers: 4,
          trackedMembers: 4,
        },
        qualityEntries: [qualityEntry({ id: 1, enteredAt: "2026-08-01T06:00:00.000Z" })],
      },
    );

    const out = await service.getActivity("day", 9);

    expect(out.entries.map((e) => e.id)).toEqual(["quality-1", "approval:41", "downtime:7"]);
  });

  it("404s when the coarse line report does not exist", async () => {
    const { service } = cascadeSetup({ report: null });

    await expect(service.getActivity("day", 9)).rejects.toMatchObject({ status: 404 });
  });
});

// TODOS §50, one subject wider. A line's aggregates are precomputed by the
// pipeline exactly as a machine's are, so an operator moving a stop's CATEGORY
// leaves this screen's OEE tiles, timeline strip and waterfall showing the
// pre-edit split — and only the machine screen warned about that.
describe("WorkCenterReportService — the stale-metrics banner", () => {
  it("reports the instant a category was last edited on this line's stops", async () => {
    const at = new Date("2026-08-09T10:00:00Z");
    const { service } = cascadeSetup({ categoryEditedAt: at });

    expect(await service.getMetricsStaleness(7)).toEqual({ categoryEditedAt: at });
  });

  // NULL IS "NOTHING WAS EDITED", and it is the reassuring answer — which is why
  // the 404 below matters more than it looks.
  it("reports null when nothing was edited", async () => {
    const { service } = cascadeSetup();

    expect(await service.getMetricsStaleness(7)).toEqual({ categoryEditedAt: null });
  });

  // A MISSING REPORT MUST NOT ANSWER "NOTHING WAS EDITED". That is the same
  // instant-not-a-verdict rule the payload's shape encodes: the one thing this
  // endpoint may never do is reassure a reader about a report it could not find.
  it("404s rather than reporting no edit for a report that does not exist", async () => {
    const { service } = cascadeSetup({ report: null });

    await expect(service.getMetricsStaleness(7)).rejects.toMatchObject({ status: 404 });
  });

  // OVER THE SAME STOP SET THE ACTIVITY FEED USES — both go through
  // resolveLineShift, so they cannot disagree about which stops belong to this
  // line shift. If they did, the Log Activity panel would list a category edit
  // this endpoint did not think had happened.
  it("scopes by the line, through the same resolver the activity feed uses", async () => {
    const { service, getCategoryEditedAt, listWorkUnitIds } = cascadeSetup();

    await service.getMetricsStaleness(7);

    expect(getCategoryEditedAt).toHaveBeenCalledWith(
      expect.objectContaining({ workCenterId: 11, shift: 2 }),
    );
    expect(listWorkUnitIds).not.toHaveBeenCalled();
  });
});
