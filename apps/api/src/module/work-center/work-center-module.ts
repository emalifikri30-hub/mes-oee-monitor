import { asClass, type AwilixContainer } from "awilix";

import {
  WorkCenterReportReaderRepository,
  WorkCenterReportWriterRepository,
} from "./work-center-repository.js";
import { WorkCenterReportService } from "./work-center-service.js";

function registerWorkCenter(container: AwilixContainer) {
  container.register({
    // A READER AND A WRITER, and the split is what marks which one may mutate —
    // the Gold pool is read-write, so the types are the only marker there is.
    //
    // THE WRITER TOUCHES NO work_center_* TABLE. This module had no writer at all
    // until the line approval, and the reason it has one now is not that the line
    // tables became mutable: approving a line closes the MACHINE shift reports on
    // it, in oee.work_unit_shift_report_approvals, because that table is keyed
    // (work_unit_id, date, shift) and these three have no work_unit_id column.
    // Migration 0014's trigger comment is still accurate.
    workCenterReportReaderRepository: asClass(WorkCenterReportReaderRepository).scoped(),
    workCenterReportWriterRepository: asClass(WorkCenterReportWriterRepository).scoped(),
    workCenterReportService: asClass(WorkCenterReportService).scoped(),
  });
}

export { registerWorkCenter };
