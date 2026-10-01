import { asClass, type AwilixContainer } from "awilix";

import {
  WorkUnitReportReaderRepository,
  WorkUnitReportWriterRepository,
} from "./work-unit-repository.js";
import { WorkUnitReportService } from "./work-unit-service.js";

function registerWorkUnit(container: AwilixContainer) {
  container.register({
    workUnitReportReaderRepository: asClass(WorkUnitReportReaderRepository).scoped(),
    // Registered separately from the reader, not because the container needs two
    // entries but because the TYPES do: the Gold pool is read-write, so the
    // reader/writer split is the only thing marking which repository is allowed
    // to mutate.
    workUnitReportWriterRepository: asClass(WorkUnitReportWriterRepository).scoped(),
    workUnitReportService: asClass(WorkUnitReportService).scoped(),
  });
}

export { registerWorkUnit };
