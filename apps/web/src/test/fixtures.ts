import type {
  AreaReportDetail,
  DowntimeListItem,
  LineReportDetail,
  SkuReportDetail,
  PeriodReportDetail,
  ShiftReportDetail,
} from "@/lib/types";

// A complete ShiftReportDetail, since the type has ~40 required fields and no
// card needs more than a handful of them. Tests override only what they assert
// on, so a new column added upstream costs one line here rather than one per
// test file.
//
// The date is the shift's START INSTANT, not a calendar day: 2026-08-09T00:00Z
// is 07:00 on the 9th at Asia/Jakarta, i.e. shift 1 of business day 2026-08-09.
// Getting that wrong is the bug TODOS.md §17 records as already shipped once.
function shiftReport(overrides: Partial<ShiftReportDetail> = {}): ShiftReportDetail {
  return {
    subject: "machine",
    grain: "shift",
    id: 1,
    shift: 1,
    date: "2026-08-09T00:00:00.000Z",
    timeZone: "Asia/Jakarta",
    workUnitId: 42,
    workUnitName: "Vertical Packer MJCL",
    workCenterId: 7,
    workCenterName: "Line 2",
    uomId: 3,
    uomName: "BAG",

    // Open, which is what every report is until somebody approves it. Tests that
    // care about the closed state override the whole object.
    approval: {
      status: "open",
      closedAt: null,
      closedBy: null,
      closedByName: null,
      source: null,
    },

    teep: 0.4,
    oee: 0.62,
    availability: 0.8,
    performance: 0.85,
    quality: 0.91,
    totalOut: 3416,
    goodOut: 3200,
    effectiveOut: 3100,

    runtime: 28_800_000,
    availabilityTime: 28_800_000,
    productionTime: 27_072_000,
    pdtTime: 1_728_000,
    operatingTime: 25_000_000,
    updtTime: 2_072_000,
    netTime: 24_000_000,
    reduceSpeedTime: 1_000_000,
    msTime: 1_386_000,
    valueAddedTime: 22_000_000,
    reworkTime: 0,
    rejectTime: 284_000,
    anomalyTime: 0,
    upSpeedTime: 107_000,

    scheduleLossTime: 1_727_000,
    availabilityLossTime: 0,
    performanceLossTime: 1_277_000,
    msLossTime: 1_386_000,
    reduceSpeedLossTime: -107_000,
    qualityLossTime: 284_000,

    reject: 3416,
    rework: 0,

    mttr: 600_000,
    mtbf: 7_200_000,
    ...overrides,
  };
}

// One row of either downtime table.
//
// SHARED between the two suites that render DowntimeDetailSheet, which is the
// point: the drawer is fed by two different tables, and a fixture per suite is
// how they would come to disagree about which fields a row carries. The 0007
// fields default to null because that is every row in the reporting database
// today — the pipeline that would write them does not exist yet.
function downtimeItem(overrides: Partial<DowntimeListItem> = {}): DowntimeListItem {
  return {
    id: 1,
    sourceEventId: null,
    reason: ["Mlipit"],
    actions: [],
    category: "UNPLANNED",
    workUnitName: "Vertical Packer MJCL",
    workCenterName: "H2-4",
    areaName: null,
    // NOT NULL by default, unlike the other 0007 fields: this one is what scopes
    // the edit dialog's Reason catalogue on an AREA report, and a fixture defaulting
    // it to null would make every test of that path exercise the unscoped arm.
    workCenterId: 2,
    detailReason: null,
    inputBy: null,
    maintainedBy: null,
    startAt: "2026-08-09T01:14:00.000Z",
    endAt: "2026-08-09T01:20:00.000Z",
    durationMs: 360_000,
    timeZone: "Asia/Jakarta",
    ...overrides,
  };
}

// A complete PeriodReportDetail, on the same terms as shiftReport above.
//
// Defaults to DAY grain and to the state the pipeline actually produces today:
// mttr/mtbf null because nothing computes them yet, and an approval summary
// because the API returns one at day grain. A month fixture is
// `periodReport({ grain: "month", approval: null })` — the pairing matters, and
// tests that need it say both.
function periodReport(overrides: Partial<PeriodReportDetail> = {}): PeriodReportDetail {
  return {
    subject: "machine",
    grain: "day",
    id: 1,
    // 07:00 plant-local on the business day below, which at Asia/Jakarta is
    // 00:00Z. Nothing renders this — see businessDate.
    date: "2026-08-09T00:00:00.000Z",
    // THE FIELD THE SCREENS USE. A plain business day, already plant-local, so
    // no formatter here may push it through a zone.
    businessDate: "2026-08-09",
    timeZone: "Asia/Jakarta",
    month: null,
    workUnitId: 42,
    workUnitName: "Vertical Packer MJCL",
    workUnitCode: "VP-MJCL",
    workCenterId: 7,
    workCenterName: "Line 2",
    workCenterCode: "L2",
    uomId: 1,
    uomName: "BAG",
    uomCode: "BAG",

    teep: 61.5,
    oee: 82.5,
    availability: 90,
    performance: 95,
    quality: 96.5,
    totalOut: 3000,
    goodOut: 2895,
    effectiveOut: 2895,

    runtime: 77_760_000,
    availabilityTime: 86_400_000,
    productionTime: 82_800_000,
    pdtTime: 3_600_000,
    operatingTime: 77_760_000,
    updtTime: 5_040_000,
    netTime: 75_600_000,
    reduceSpeedTime: 1_200_000,
    msTime: 960_000,
    valueAddedTime: 73_800_000,
    reworkTime: 600_000,
    rejectTime: 1_200_000,
    anomalyTime: 0,
    upSpeedTime: 0,

    scheduleLossTime: 3_600_000,
    availabilityLossTime: 5_040_000,
    performanceLossTime: 2_160_000,
    msLossTime: 960_000,
    reduceSpeedLossTime: 1_200_000,
    qualityLossTime: 1_800_000,

    reject: 75,
    rework: 30,

    // NULL, not 0, and that is the point of the pairing: 0 renders "00 s" and
    // claims a perfect repair time, null renders an em dash and claims nothing.
    mttr: null,
    mtbf: null,

    approval: { shiftsTotal: 3, shiftsClosed: 2 },
    ...overrides,
  };
}

// A complete LineReportDetail.
//
// ITS SHAPE WAS CAPTURED FROM THE RUNNING ENDPOINT, not read off the migration —
// field names, nesting, nullability and the camelCasing postgres.js applies were
// all dumped from WorkCenterReportReaderRepository.getReport against a real
// Postgres and copied here. That provenance is the point: the Line LIST type
// shipped saying `workCenter: { name }` where the endpoint sends a flat
// `workCenterName`, every Line cell rendered an em dash, and the component test
// could not catch it because ITS FIXTURE WAS BUILT FROM THE SAME WRONG TYPE
// (commit 0ed9c20). A captured response is the remedy that commit established.
//
// The VALUES are representative rather than captured — they came from the row the
// capture inserted. The unit names follow shiftReport's ("BAG"), because that is
// what mes-master-data actually sends.
//
// THE TWO UNITS ARE DIFFERENT ON PURPOSE: infeed BAG, output CARTON. That is the
// ordinary case for a line (it consumes bags and ships cartons), and a fixture
// where they matched would let a card mislabel one side without failing. Any test
// that touches a count should assert the unit beside it.
//
//   infeed  (BAG)     totalOut 70811 · lineOut 64818 · reject 5000 · rework 993
//   output  (CARTON)  goodOut 789 · effectiveOut 79821.3
//
// So `totalOut !== goodOut + reject + rework` here, by construction. Do not
// "correct" these numbers into reconciling: at this grain that identity is false,
// and a fixture asserting it would teach the opposite of what 0014 documents.
// ONE SKU, ON ONE LINE, ON ONE BUSINESS DAY.
//
// The same two-unit split the line fixture documents, and for the same reason: a
// SKU inherits its line's two count points. `totalOut !== goodOut + reject +
// rework` here BY CONSTRUCTION (contract §16.4a) — do not "correct" these numbers
// into reconciling.
//
//   infeed  (BAG)     totalOut 23130 · lineOut 22667 · reject 300 · rework 60
//   output  (CARTON)  goodOut 1905 · effectiveOut 1890
//
// `workCenterCode` is populated deliberately: the SKU screens render it BESIDE
// the line name because work_center_name is not unique (TODOS.md §77), and a
// fixture with a null code would let that pairing regress unnoticed.
function skuReport(overrides: Partial<SkuReportDetail> = {}): SkuReportDetail {
  return {
    subject: "sku",
    grain: "day",
    id: 79,
    businessDate: "2026-08-19",
    timeZone: "Asia/Jakarta",
    workCenterId: 3,
    workCenterName: "Line 2",
    workCenterCode: "FI2-L2",
    areaId: 2,
    areaName: "FI2",
    productId: 1,
    productName: "SKU A",
    productCode: "SKU0A",

    infeedUomId: 1,
    infeedUomName: "Bag",
    infeedUomCode: "BAG",
    outputUomId: 42,
    outputUomName: "Carton",
    outputUomCode: "CTN",

    oee: 84.326,
    availability: 89.947,
    performance: 94.075,
    quality: 99.655,

    totalOut: 23130,
    reject: 300,
    rework: 60,
    lineOut: 22667,
    goodOut: 1905,
    effectiveOut: 1890,

    runtime: 49734740,
    availabilityTime: 55296000,
    productionTime: 55296000,
    pdtTime: 0,
    operatingTime: 49734740,
    updtTime: 5561260,
    netTime: 46786000,
    reduceSpeedTime: 2948740,
    msTime: 0,
    valueAddedTime: 46625000,
    reworkTime: 60000,
    rejectTime: 101000,
    anomalyTime: 0,
    upSpeedTime: 0,
    scheduleLossTime: 0,
    availabilityLossTime: 5561260,
    performanceLossTime: 2948740,
    msLossTime: 0,
    reduceSpeedLossTime: 2948740,
    qualityLossTime: 161000,
    mttr: null,
    mtbf: null,
    ...overrides,
  };
}

function lineReport(overrides: Partial<LineReportDetail> = {}): LineReportDetail {
  return {
    subject: "line",
    grain: "shift",
    id: 331,
    shift: 1,
    // A plain business day. These tables have NO `date timestamptz` column, so
    // there is no instant here and nothing to convert — never formatReportDate.
    businessDate: "2026-08-01",
    timeZone: "Asia/Jakarta",
    workCenterId: 9999,
    workCenterName: "Molca Line 8",
    workCenterCode: "L8",
    areaId: 5,
    areaName: "Filling",
    workUnitCount: 4,
    expectedWorkUnitCount: 5,

    infeedUomId: 41,
    infeedUomName: "BAG",
    infeedUomCode: "BAG",
    outputUomId: 42,
    outputUomName: "CARTON",
    outputUomCode: "CARTON",

    teep: 61.5,
    oee: 71.63,
    availability: 100,
    performance: 72.613,
    quality: 98.646,

    totalOut: 70811,
    reject: 5000,
    rework: 993,
    lineOut: 64818,
    goodOut: 789,
    effectiveOut: 79821.3,

    runtime: 73681000,
    availabilityTime: 86400000,
    productionTime: 82800000,
    pdtTime: 3600000,
    operatingTime: 77760000,
    updtTime: 5040000,
    netTime: 75600000,
    reduceSpeedTime: 1200000,
    msTime: 960000,
    valueAddedTime: 73800000,
    reworkTime: 600000,
    rejectTime: 1200000,
    anomalyTime: 0,
    upSpeedTime: 0,

    scheduleLossTime: 3600000,
    availabilityLossTime: 5040000,
    performanceLossTime: 2160000,
    msLossTime: 960000,
    // Negative, as the captured row is. Losses are signed.
    reduceSpeedLossTime: -1200000,
    qualityLossTime: 1800000,

    mttr: 600000,
    mtbf: 7200000,
    ...overrides,
  } as LineReportDetail;
}

// A complete AreaReportDetail.
//
// THE DURATIONS ARE DELIBERATELY ABOVE A DAY. `availabilityTime` here is 48 hours
// and `runtime` is ~33 — two lines' worth — because an area has no clock of its own
// and every duration on the row is summed across its lines (migration 0024,
// consequence 1). A fixture with 24-hour figures would let a card that divided by a
// line count pass, and that is the one arithmetic error this grain invites.
//
// ONE UNIT, AND IT IS A MASS. `weightUom*` rather than the line's two triples: an
// area's members disagree about both sides, so mass is the only unit they can all
// be expressed in. The counts below are therefore all kilograms and all comparable
// — which is what makes it worth pinning that no card ADDS them, since here the
// arithmetic would at least be unit-consistent.
function areaReport(overrides: Partial<AreaReportDetail> = {}): AreaReportDetail {
  return {
    subject: "area",
    grain: "day",
    id: 11,
    // A plain business day. This table has NO `date timestamptz` column, so there
    // is no instant here and nothing to convert — never formatReportDate.
    businessDate: "2026-09-01",
    timeZone: "Asia/Jakarta",
    areaId: 2,
    areaName: "Filling 2",
    areaCode: "FI2",
    siteId: 1,
    siteName: "Ajinomoto Mojokerto NE",
    enterpriseId: 1,
    enterpriseName: "Ajinomoto Indonesia",

    weightUomId: 7,
    weightUomName: "Kilogram",
    weightUomCode: "KG",

    oee: 71.429,
    availability: 83.571,
    performance: 92.308,
    quality: 92.593,

    totalOut: 24000,
    areaOut: 23400,
    reject: 480,
    rework: 120,
    goodOut: 22800,

    // 33.89 h and 48 h. See the header: line-hours, not wall-clock hours.
    runtime: 122000000,
    availabilityTime: 172800000,
    productionTime: 140000000,
    pdtTime: 32800000,
    operatingTime: 117000000,
    updtTime: 23000000,
    netTime: 108000000,
    reduceSpeedTime: 9000000,
    msTime: 3200000,
    valueAddedTime: 100000000,
    reworkTime: 3600000,
    rejectTime: 4400000,
    anomalyTime: 900000,
    upSpeedTime: 150000,

    scheduleLossTime: 32800000,
    availabilityLossTime: 23000000,
    performanceLossTime: 9000000,
    msLossTime: 3200000,
    reduceSpeedLossTime: 5800000,
    qualityLossTime: 8000000,

    mttr: 3285714,
    mtbf: 16714286,
    ...overrides,
  };
}

export { areaReport, downtimeItem, lineReport, periodReport, shiftReport, skuReport };
