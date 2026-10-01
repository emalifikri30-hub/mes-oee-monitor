import { asClass, type AwilixContainer } from "awilix";

import { QualityEntryRepository } from "./quality-entry-repository.js";
import { QualityEntryService } from "./quality-entry-service.js";

// ONE REPOSITORY, NOT A READER/WRITER PAIR, which every other module here has.
//
// The split exists elsewhere to mark which class may mutate, because the Gold
// pool is read-write and the types are the only marker there is. It buys nothing
// here: this module's ENTIRE PURPOSE is one table it both reads and writes, so a
// reader that could not write would be a reader of the same three columns the
// writer reads before writing them. The interfaces are still separate — the
// service depends on `QualityEntryReader & QualityEntryWriter` — so a future
// split costs a registration and no call sites.
function registerQualityEntry(container: AwilixContainer) {
  container.register({
    qualityEntryRepository: asClass(QualityEntryRepository).scoped(),
    qualityEntryService: asClass(QualityEntryService).scoped(),
  });
}

export { registerQualityEntry };
