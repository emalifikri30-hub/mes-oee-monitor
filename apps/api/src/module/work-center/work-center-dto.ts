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

// The Line list filters. Both schemas are built from shared/report-filter-dto.ts
// rather than restated — see that file for the two traps a hand-copied version
// would lose.
//
// TWO SCHEMAS, NOT ONE WITH AN OPTIONAL FIELD. `shift` exists only at shift
// grain, and a schema that accepted it everywhere would let /day-reports?shift=2
// look like a filtered request.
//
// NEITHER HAS `status`, AND THAT IS THE CONTRACT RATHER THAN AN OMISSION.
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift);
// these tables have no work_unit_id at all, so there is nothing to correlate an
// approval against and nothing for a filter to mean.
//
// `workCenterId` IS part of the repository's filter here, unlike in
// work-unit-dto.ts where it is resolved into a list of machine ids by calling
// mes-master-data first. work_center_id is this grain's key, so it is a plain
// predicate — see WorkCenterReportFilter for what that changes about 404s.
//
// `areaId` is a plain predicate for a DIFFERENT reason, and the difference is
// worth keeping straight one line apart: `work_center_id` is this grain's KEY,
// where `area_id` is a denormalised LABEL `0014` put on these tables and `0028`
// carried onto the year one. A key is always populated; a label may be NULL while
// the pipeline catches up, and such a row appears on no screen at all. See
// shared/area-scope.ts.

const listShiftReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  shift: shiftFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

const listPeriodReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

// The YEAR list filter — the coarse schema MINUS `month`, written out rather than
// `.omit()`d so each screen's contract reads as the list of fields it has.
// area-report-dto.ts makes the same call between its own two grains.
const listYearReportInputSchema = paginationSchema.extend({
  year: yearFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  isHideZero: hideZeroFilter,
});

const workCenterValidator = {
  listShiftReport: queryValidator(listShiftReportInputSchema),
  listPeriodReport: queryValidator(listPeriodReportInputSchema),
  listYearReport: queryValidator(listYearReportInputSchema),
};

type ListWorkCenterShiftReportQuery = z.infer<typeof listShiftReportInputSchema>;
type ListWorkCenterPeriodReportQuery = z.infer<typeof listPeriodReportInputSchema>;

export {
  workCenterValidator,
  listShiftReportInputSchema,
  listPeriodReportInputSchema,
  listYearReportInputSchema,
};
type ListWorkCenterYearReportQuery = z.infer<typeof listYearReportInputSchema>;

export type {
  ListWorkCenterShiftReportQuery,
  ListWorkCenterPeriodReportQuery,
  ListWorkCenterYearReportQuery,
};
