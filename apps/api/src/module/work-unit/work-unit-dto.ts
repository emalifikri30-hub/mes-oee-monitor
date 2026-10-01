import * as z from "zod";

import { paginationSchema, queryValidator } from "@molca/helper";
import {
  areaIdFilter,
  hideZeroFilter,
  monthFilter,
  shiftFilter,
  workCenterIdFilter,
  yearFilter,
} from "../../shared/report-filter-dto.js";

// The By Shift list filter.
//
// `month`, `year`, `shift`, `workCenterId` and `isHideZero` come from
// shared/report-filter-dto.ts, which they were lifted into once the work-center
// module needed the same five. The two traps that used to be documented here —
// `shift` reaching the repository as a NUMBER, and its empty-string arm having to
// sit ahead of the numeric check — live in that file now, next to the code they
// describe rather than next to one of its two callers.
//
// `workCenterId` is NOT part of THIS module's repository filter — it is resolved
// into a list of work-unit ids by calling mes-master-data first. See the pipeline
// comment in work-unit-service.ts. (The work-center module uses the same
// validator for a column predicate; the shape of the input is what is shared, not
// what is done with it.)
//
// `areaId` IS a column predicate, and it is the newer of the two shapes. The web
// app sends it on EVERY report request now, from the header picker — see
// `areaIdFilter`'s header in shared/report-filter-dto.ts, which used to say the
// area reports were "the first screens where it does" filter a request and is now
// a note about every screen. Migration `0028` is what makes it a predicate rather
// than a second hierarchy round trip: `oee.work_unit_shift_reports` carries
// `area_id` from that migration on.
const listShiftReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  shift: shiftFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
  // Approval state. Absent means BOTH, which is why this is `optional` on an enum
  // rather than a `.default()` — there is no third literal for "either", and
  // inventing one would put a value in the vocabulary the repository has to
  // translate back to "no predicate".
  //
  // NOT LIFTED INTO shared/, unlike the five above, and that is the same call
  // report-filter-dto.ts's header describes: this has exactly one caller and no
  // prospect of a second. Only a MACHINE shift report has an approval —
  // oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift) —
  // so no other grain and no other subject has anything for it to filter on.
  //
  // THE EMPTY-STRING ARM MATTERS, and it is the same trap `shift` documents in
  // shared/: the By Shift screen clears a filter by dropping the value, but a
  // hand-edited or bookmarked URL keeps the key. `?status=` must mean "both",
  // not 400.
  status: z.pipe(
    z.pipe(
      z.optional(z.string()),
      z.transform((v) => (v === undefined || v === "" ? undefined : v)),
    ),
    z.optional(z.enum(["open", "closed"])),
  ),
});

// The By Day / By Monthly list filter.
//
// The shift list's schema minus two fields, and both absences are decisions
// rather than omissions:
//
//   no `shift`   — there is no shift at these grains. Accepting and ignoring one
//                  would answer a filtered request with an unfiltered page.
//   no `status`  — there is no day or month approval to filter on. The detail
//                  screen derives a shift COUNT (see PeriodApprovalSummary); a
//                  list-wide filter would need that per row, and the list
//                  deliberately does not pay for it.
//
// `month` and `year` keep the shift list's spelling exactly, because the two
// screens share a filter bar and a URL that works on one should work on the
// other. They filter `business_date` here rather than a timestamptz, which is
// what makes them exact — see businessDateFilter.
const listPeriodReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

// The YEAR list filter — the coarse schema MINUS `month`.
//
// Written out rather than `.omit()`d, so each screen's contract reads as the list
// of fields it has. area-report-dto.ts makes the same call between its two grains
// and for the same reason.
//
// NO `month`, AND IT IS REFUSED RATHER THAN DROPPED. A year list narrowed to one
// month is a different question, and the rule listPeriodReportInputSchema's header
// states is the one being followed: never accept a filter the server ignores.
// `paginationSchema` is not strict, so an unknown key would not reach the filter
// either way — but a schema that never declares the field cannot be added to this
// object by a later edit and then silently dropped downstream.
const listYearReportInputSchema = paginationSchema.extend({
  year: yearFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

const workUnitValidator = {
  listShiftReport: queryValidator(listShiftReportInputSchema),
  listPeriodReport: queryValidator(listPeriodReportInputSchema),
  listYearReport: queryValidator(listYearReportInputSchema),
};

type ListShiftReportQuery = z.infer<typeof listShiftReportInputSchema>;
type ListPeriodReportQuery = z.infer<typeof listPeriodReportInputSchema>;

export {
  workUnitValidator,
  listShiftReportInputSchema,
  listPeriodReportInputSchema,
  listYearReportInputSchema,
};
type ListYearReportQuery = z.infer<typeof listYearReportInputSchema>;

export type { ListShiftReportQuery, ListPeriodReportQuery, ListYearReportQuery };
