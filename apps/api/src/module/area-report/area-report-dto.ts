import * as z from "zod";

import { paginationSchema, queryValidator } from "@molca/helper";
import {
  areaIdFilter,
  hideZeroFilter,
  monthFilter,
  yearFilter,
} from "../../shared/report-filter-dto.js";

// The AREA list filters. Built from shared/report-filter-dto.ts rather than
// restated — see that file for the traps a hand-copied coercion would lose, and
// for why `areaIdFilter` lives there rather than here.
//
// TWO SCHEMAS FOR TWO GRAINS, and the difference between them is ONE FIELD.
//
// THE REQUIREMENT'S FILTERS, WHICH DIFFER BY GRAIN AND NOT BY ACCIDENT:
//
//   By Day      month, year, area, hide-zero-OEE
//   By Monthly  ......  year, area, hide-zero-OEE
//
// So the month list does not accept `month` AT ALL, and that is stricter than the
// six shipped By Monthly screens — work-unit's and work-center's coarse lists
// share one validator with their day siblings and take a month at both grains.
// The requirement asked for the difference in as many words: **"Monthly Report
// (Show all month on selected year)"**. A month filter would contradict the
// screen's own heading, and a month list narrowed to one month is one row.
//
// REFUSED WITH A 400 RATHER THAN ACCEPTED AND DROPPED. `paginationSchema` is not
// strict, so an unknown key does not reach the filter either way — but a schema
// that never declares the field is the honest version: it cannot be added to this
// object by a later edit and then silently ignored downstream. The repository
// therefore needs no second guard for it, unlike work-center's `shiftFilter(grain,
// …)`, which exists because ITS dto drops the key instead of refusing it.
//
// WHAT IS DELIBERATELY ABSENT FROM BOTH:
//
//   no `shift`         there is no shift grain on this subject at all, and there
//                      will not be one. Accepting and ignoring one would answer a
//                      filtered request with an unfiltered page, which reads as
//                      data rather than as an error.
//   no `workCenterId`  an area report is not scoped by a line. A line filter here
//                      would name a subset the row's own figures were never
//                      computed over, so the page would show one area's OEE under
//                      a heading claiming one line.
//   no `status`        oee.work_unit_shift_report_approvals is keyed
//                      (work_unit_id, date, shift). An area report has neither,
//                      and it is not approvable at either grain, so there is
//                      nothing to correlate against and nothing for a filter to
//                      mean.
//
// THE AREA ITSELF is `areaId`, and the browser sources it from the HEADER's area
// picker rather than from a control on the screen — deliberately, because the
// requirement says so ("use existing filter area on the header layout") and
// because that picker's selection is already app-wide state.

const listAreaDayReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

// The day schema minus `month`. Written out rather than `.omit()`, so the field
// list of each screen's contract reads in one place — the same call work-unit's
// two schemas make.
const listAreaMonthReportInputSchema = paginationSchema.extend({
  year: yearFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

// The YEAR list. IDENTICAL IN SHAPE to the month schema above, and written out a
// third time rather than aliased — this file's own call, made twice already: each
// screen's contract reads as the list of fields it has, and the two schemas being
// the same today is a coincidence of the requirement rather than a rule. A `year`
// list narrowed by `month` is as meaningless as a month list narrowed by one.
const listAreaYearReportInputSchema = paginationSchema.extend({
  year: yearFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

const areaReportValidator = {
  listDayReport: queryValidator(listAreaDayReportInputSchema),
  listMonthReport: queryValidator(listAreaMonthReportInputSchema),
  listYearReport: queryValidator(listAreaYearReportInputSchema),
};

type ListAreaDayReportQuery = z.infer<typeof listAreaDayReportInputSchema>;
type ListAreaMonthReportQuery = z.infer<typeof listAreaMonthReportInputSchema>;

export {
  areaReportValidator,
  listAreaDayReportInputSchema,
  listAreaMonthReportInputSchema,
  listAreaYearReportInputSchema,
};
type ListAreaYearReportQuery = z.infer<typeof listAreaYearReportInputSchema>;

export type { ListAreaDayReportQuery, ListAreaMonthReportQuery, ListAreaYearReportQuery };
