import { asClass, type AwilixContainer } from "awilix";

import { AreaReportReaderRepository } from "./area-report-repository.js";
import { AreaReportService } from "./area-report-service.js";

function registerAreaReport(container: AwilixContainer) {
  container.register({
    // A READER AND NO WRITER, and the absence is the statement. The Gold pool is
    // read-write, so a type is the only thing marking which repositories may
    // mutate — work-unit-module.ts and work-center-module.ts each register a
    // writer beside their reader for that reason.
    //
    // There is nothing here for one to do, and this grain's case is the strongest
    // of the four. A SKU report at least has an operator write on its screen (the
    // reject/rework ledger, which lands in another module's table); an AREA report
    // has none at all — the requirement says "no add reject/rework", there is no
    // approval to record (oee.work_unit_shift_report_approvals is keyed
    // (work_unit_id, date, shift), and this grain has neither), and every measure
    // is the pipeline's. Migration 0024's write_audit triggers say the same thing
    // from the database's side.
    //
    // THE ONE DEPENDENCY THAT COULD LOOK LIKE A WRITE PATH IS A READER.
    // AreaReportService takes `qualityEntryRepository` for the activity feed's
    // quality arm — the same seam the work-centre and product services use — and a
    // QualityEntryReader cannot mutate anything. If an
    // AreaReportWriterRepository ever appears here, something has gone wrong.
    areaReportReaderRepository: asClass(AreaReportReaderRepository).scoped(),
    areaReportService: asClass(AreaReportService).scoped(),
  });
}

export { registerAreaReport };
