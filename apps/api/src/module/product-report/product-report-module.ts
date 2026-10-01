import { asClass, type AwilixContainer } from "awilix";

import { ProductReportReaderRepository } from "./product-report-repository.js";
import { ProductReportService } from "./product-report-service.js";

function registerProductReport(container: AwilixContainer) {
  container.register({
    // A READER AND NO WRITER, and the absence is the statement. The Gold pool is
    // read-write, so a type is the only thing marking which repositories may
    // mutate — work-unit-module.ts and work-center-module.ts each register a
    // writer beside their reader for that reason.
    //
    // There is nothing here for one to do. A SKU has no approval to record
    // (oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift),
    // and this grain has neither), and its measures are the pipeline's. Migration
    // 0023's write_audit trigger comment says the same thing from the database's
    // side: no operator mutation targets oee.product_report_wc_day.
    //
    // STILL TRUE NOW THAT THE SKU SCREEN HAS A WRITE, and this is the check on
    // that arrangement rather than a caveat to it. An operator can record reject
    // and rework from the SKU day report, and that write lands in
    // oee.work_center_quality_entries through the QUALITY-ENTRY module, which owns
    // the table and registers its own writer. What this service gained is a
    // qualityEntryReader — for the activity feed's quality arm — and a reader
    // cannot mutate anything. If a ProductReportWriterRepository ever appears
    // here, something has gone wrong.
    productReportReaderRepository: asClass(ProductReportReaderRepository).scoped(),
    productReportService: asClass(ProductReportService).scoped(),
  });
}

export { registerProductReport };
