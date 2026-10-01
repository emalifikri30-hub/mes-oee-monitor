import {
  type AwilixContainer,
  createContainer as newContainer,
  InjectionMode,
  asValue,
  asFunction,
} from "awilix";

import type { Probe } from "../../module/health/health-service.js";
import type { AppConfig, OperatorRoles } from "../../shared/config/config.js";
import type { GoldDB, SilverDB } from "../../shared/database/postgres.js";

import { baseLogger } from "@molca/observability";
import { registerInfra } from "../../shared/infra-module.js";
import { registerHealth } from "../../module/health/health-module.js";
import { registerMasterData } from "../../module/master-data/master-data-module.js";
import { registerWorkUnit } from "../../module/work-unit/work-unit-module.js";
import { registerQualityEntry } from "../../module/quality-entry/quality-entry-module.js";

import type { QualityEntryRepository } from "../../module/quality-entry/quality-entry-repository.js";
import type { QualityEntryService } from "../../module/quality-entry/quality-entry-service.js";
import { registerProductReport } from "../../module/product-report/product-report-module.js";
import { registerAreaReport } from "../../module/area-report/area-report-module.js";
import { registerWorkCenter } from "../../module/work-center/work-center-module.js";
import { registerDowntime } from "../../module/downtime/downtime-module.js";
import type { MasterDataClientContract } from "@molca/contract-client";
import type { TimeZoneResolverContract } from "../../module/master-data/time-zone-resolver.js";
import type { MasterDataServiceContract } from "../../module/master-data/master-data-service.js";
import type {
  WorkUnitReportReader,
  WorkUnitReportWriter,
} from "../../module/work-unit/work-unit-repository.js";
import type { TWorkUnitReportService } from "../../module/work-unit/work-unit-service.js";
import type {
  WorkCenterReportReader,
  WorkCenterReportWriter,
} from "../../module/work-center/work-center-repository.js";
import type { TProductReportService } from "../../module/product-report/product-report-service.js";
import type { ProductReportReader } from "../../module/product-report/product-report-repository.js";
import type { TAreaReportService } from "../../module/area-report/area-report-service.js";
import type { AreaReportReader } from "../../module/area-report/area-report-repository.js";
import type { TWorkCenterReportService } from "../../module/work-center/work-center-service.js";
import type { DowntimeReader, DowntimeWriter } from "../../module/downtime/downtime-repository.js";
import type { TDowntimeTimelineService } from "../../module/downtime/downtime-service.js";
import type { AuthMiddleware, ServiceTokenProvider } from "@molca/mes";

// Awilix runs in PROXY mode with `strict: true`, so every name a constructor
// destructures must appear here AND be registered — an omission throws at
// resolve time, not at boot.
type Cradle = {
  goldDb: GoldDB;
  silverDb: SilverDB;
  authMw: AuthMiddleware;
  // The three optional role names from AppConfig.auth.roles, as ONE Cradle entry
  // rather than three: services destructure it whole, and a per-mutation entry
  // would add two names to this type to carry the same object.
  operatorRoles: OperatorRoles;
  serviceTokenProvider: ServiceTokenProvider;
  masterDataBaseUrl: string;
  masterDataTimeoutMs: number;
  keycloakProbe: Probe;
  goldProbe: Probe;
  silverProbe: Probe;
  masterDataClient: MasterDataClientContract;
  masterDataService: MasterDataServiceContract;
  timeZoneResolver: TimeZoneResolverContract;
  workUnitReportReaderRepository: WorkUnitReportReader;
  workUnitReportWriterRepository: WorkUnitReportWriter;
  workUnitReportService: TWorkUnitReportService;
  // The writer mutates the WORK_UNIT approval tables, never the work_center_*
  // ones — a line approval is N machine approvals. See work-center-module.ts.
  workCenterReportReaderRepository: WorkCenterReportReader;
  workCenterReportWriterRepository: WorkCenterReportWriter;
  workCenterReportService: TWorkCenterReportService;
  productReportService: TProductReportService;
  productReportReaderRepository: ProductReportReader;
  // THE AREA GRAIN. A reader and no writer, like the SKU one and for a stronger
  // reason — an area report takes no operator mutation at all. See
  // area-report-module.ts.
  areaReportService: TAreaReportService;
  areaReportReaderRepository: AreaReportReader;
  // Part 3. One repository rather than a reader/writer pair — see
  // quality-entry-module.ts for why the split buys nothing on a table this
  // module both reads and writes.
  qualityEntryRepository: QualityEntryRepository;
  qualityEntryService: QualityEntryService;
  downtimeReaderRepository: DowntimeReader;
  downtimeWriterRepository: DowntimeWriter;
  downtimeTimelineService: TDowntimeTimelineService;
};

function createContainer(config: AppConfig): AwilixContainer<Cradle> {
  const container: AwilixContainer<Cradle> = newContainer<Cradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    region: asValue(config.region),
    logger: asFunction(() => baseLogger).singleton(),
  });
  registerInfra(container, config);
  registerHealth(container, config);
  registerMasterData(container);
  registerWorkUnit(container);
  registerWorkCenter(container);
  registerProductReport(container);
  registerAreaReport(container);
  registerQualityEntry(container);
  registerDowntime(container);

  return container;
}

export { createContainer };
export type { Cradle };
