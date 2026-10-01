import { asClass, type AwilixContainer } from "awilix";

import { DowntimeReaderRepository, DowntimeWriterRepository } from "./downtime-repository.js";
import { DowntimeTimelineService } from "./downtime-service.js";

function registerDowntime(container: AwilixContainer) {
  container.register({
    downtimeReaderRepository: asClass(DowntimeReaderRepository).scoped(),
    // A SEPARATE REGISTRATION, not a second method on the reader, and the type
    // name is the only guard there is: the Gold pool is read-WRITE, so nothing
    // physical stops a read repository issuing an UPDATE. work-unit-module.ts
    // made the same split for the same reason when the approve path landed.
    downtimeWriterRepository: asClass(DowntimeWriterRepository).scoped(),
    downtimeTimelineService: asClass(DowntimeTimelineService).scoped(),
  });
}

export { registerDowntime };
