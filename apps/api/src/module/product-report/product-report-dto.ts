import * as z from "zod";

import { paginationSchema, queryValidator } from "@molca/helper";
import {
  areaIdFilter,
  hideZeroFilter,
  monthFilter,
  productIdFilter,
  workCenterIdFilter,
  yearFilter,
} from "../../shared/report-filter-dto.js";

// The SKU list filters. Built from shared/report-filter-dto.ts rather than
// restated — see that file for the traps a hand-copied coercion would lose.
//
// ONE SCHEMA, because there is one grain. The line module has two (shift and
// period) precisely so that `/day-reports?shift=2` cannot look like a filtered
// request; there is no shift here to accept or ignore.
//
// `productId` IS A FILTER, NOT THE KEY. A SKU report is addressed by its `id`
// like every other report; this narrows the LIST to one SKU across dates and
// lines, which is how a supervisor asks "where did SKU A run last month".
//
// NO `status`, for the reason the line lists have none and one more besides:
// approvals are keyed (work_unit_id, date, shift) and this table has no work unit
// at all, so there is nothing to correlate against and nothing for a filter to
// mean.
// `areaId` IS A LENS, NOT THE KEY EITHER, and it stacks with `productId` rather
// than competing with it: the header's area picker narrows every report screen,
// so this list answers "SKU A, in Filling 2, last month". `0023` put `area_id` on
// `oee.product_report_wc_day` from the start, so this needed no column — only a
// predicate.
const listProductReportInputSchema = paginationSchema.extend({
  month: monthFilter,
  year: yearFilter,
  workCenterId: workCenterIdFilter,
  areaId: areaIdFilter,
  productId: productIdFilter,
  isHideZero: hideZeroFilter,
});

const productReportValidator = {
  listReport: queryValidator(listProductReportInputSchema),
};

type ListProductReportQuery = z.infer<typeof listProductReportInputSchema>;

export { listProductReportInputSchema, productReportValidator };
export type { ListProductReportQuery };
