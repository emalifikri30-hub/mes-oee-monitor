import { describe, expect, it } from "vite-plus/test";

import {
  isMachineReport,
  qualityAddress,
  reportAddress,
  reportBusinessDay,
  reportSubject,
} from "./report-subject";
import { lineReport, periodReport, shiftReport, skuReport } from "@/test/fixtures";

// WHAT THESE ARE REALLY GUARDING, and it is not the two lines of code they cover.
//
// Until 2026-09-02 the subject was derived from SHAPE — `!("workUnitId" in report)`
// — which is sound for two subjects and silently wrong for three: a SKU report has
// no `workUnitId` either, so it read as a LINE. Every shared card, every dispatch
// hook and `reportWindowParams` branched on that one predicate, so a third subject
// would have served line data on a SKU screen everywhere at once, type-checked and
// plausible.
//
// So the assertion that matters is not "line reports say line". It is that the
// answer comes from a TAG, which a missing column cannot satisfy. A shape-based
// implementation passes every test below except the last one.
describe("reportSubject", () => {
  it("reads a machine shift report as machine", () => {
    expect(reportSubject(shiftReport())).toBe("machine");
  });

  it("reads a machine day report as machine", () => {
    expect(reportSubject(periodReport())).toBe("machine");
  });

  it("reads a line report as line", () => {
    expect(reportSubject(lineReport())).toBe("line");
  });

  // THE REGRESSION TEST FOR THE ACTUAL BUG. A report with no `workUnitId` that is
  // not a line — the shape a SKU report has. The old predicate answered "line"
  // here; the tag answers what the tag says.
  //
  // THE CAST IS GONE. This was written before SkuReportDetail existed and used
  // `as unknown as` to fake the shape; the comment said "when SkuReportDetail
  // lands this stops needing the cast", and it has. A real fixture is strictly
  // stronger: the faked object was a LINE report wearing a tag, so it could not
  // have caught a subject read off any field the two shapes do not share.
  it("does NOT read a workUnitId-less non-line report as a line", () => {
    expect(reportSubject(skuReport())).toBe("sku");
    expect(isMachineReport(skuReport())).toBe(false);
  });
});

describe("isMachineReport", () => {
  it.each([
    ["machine shift", shiftReport(), true],
    ["machine day", periodReport(), true],
    ["line", lineReport(), false],
  ])("%s -> %s", (_label, report, expected) => {
    expect(isMachineReport(report)).toBe(expected);
  });
});

// The address is what every write and invalidation names a report by. Getting the
// subject half wrong refetches a STRANGER's report while the operator's stays
// stale — which is why it is derived here rather than assembled at call sites.
describe("reportAddress", () => {
  it("carries subject, grain and id together for a machine report", () => {
    expect(reportAddress(shiftReport({ id: 7 }))).toEqual({
      subject: "machine",
      grain: "shift",
      id: 7,
    });
  });

  it("carries subject, grain and id together for a line report", () => {
    expect(reportAddress(lineReport({ id: 7, grain: "shift", shift: 1 }))).toEqual({
      subject: "line",
      grain: "shift",
      id: 7,
    });
  });

  it("carries subject, grain and id together for a SKU report", () => {
    expect(reportAddress(skuReport({ id: 79 }))).toEqual({
      subject: "sku",
      grain: "day",
      id: 79,
    });
  });

  // The seven-sequences hazard, stated as a test: id 7 is a real row in ALL THREE
  // tables and they are three different reports. Only the subject tells them
  // apart — and the SKU and the machine DAY report even share a grain, which is
  // why every consumer switches on `subject` first.
  it("distinguishes three reports sharing one id", () => {
    const machine = reportAddress(periodReport({ id: 7, grain: "day" }));
    const line = reportAddress(lineReport({ id: 7, grain: "day", shift: null }));
    const sku = reportAddress(skuReport({ id: 7 }));

    expect(machine).not.toEqual(line);
    expect(machine).not.toEqual(sku);
    expect(line).not.toEqual(sku);
  });
});

// WHERE A QUALITY ENTRY CAN LAND, and it is a NARROWER type on purpose.
//
// A machine report has no quality ledger at all: 0017 keys the table by
// work_center and treats a machine as PROVENANCE ONLY, "it does NOT move
// oee.work_unit_*_reports, and there is no join anywhere that lets it". The
// parameter type says so, so the assertions here are about the two shapes that DO
// have one resolving to their own subject.
describe("qualityAddress", () => {
  it("addresses a line report by its own grain", () => {
    expect(qualityAddress(lineReport({ id: 7, grain: "month", shift: null }))).toEqual({
      subject: "line",
      grain: "month",
      id: 7,
    });
  });

  it("addresses a SKU report at its only grain", () => {
    expect(qualityAddress(skuReport({ id: 79 }))).toEqual({
      subject: "sku",
      grain: "day",
      id: 79,
    });
  });

  // THE PAIR THAT MATTERS: a SKU report and a line DAY report sharing an id must
  // not produce the same address, because the address chooses the URL — and a SKU
  // id under /work-centers/day-reports names a row from another sequence and
  // answers with another line's ledger.
  it("never gives a SKU report and a line day report the same address", () => {
    expect(qualityAddress(skuReport({ id: 7 }))).not.toEqual(
      qualityAddress(lineReport({ id: 7, grain: "day", shift: null })),
    );
  });
});

// Three sources, and the machine shift arm is the one that must NOT be treated as
// a business day — it is the instant the shift started.
describe("reportBusinessDay", () => {
  it("returns a line report's businessDate directly", () => {
    expect(reportBusinessDay(lineReport({ businessDate: "2026-08-01" }))).toBe("2026-08-01");
  });

  it("returns a machine period report's businessDate directly", () => {
    expect(reportBusinessDay(periodReport({ businessDate: "2026-08-19" }))).toBe("2026-08-19");
  });

  it("returns null when a machine period report has no businessDate yet", () => {
    expect(reportBusinessDay(periodReport({ businessDate: null }))).toBeNull();
  });
});
