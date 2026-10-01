import { CalendarDays, Database, Gauge, LayoutGrid, Wrench } from "lucide-react";

import type { LucideIcon } from "lucide-react";

export interface MesApp {
  key: string;
  name: string;
  icon: LucideIcon;
  /** Absolute URL, or empty when the destination is not wired yet. */
  url: string;
}

export const MES_APPS: MesApp[] = [
  { key: "portal", name: "Portal", icon: LayoutGrid, url: "" },
  { key: "master-data", name: "Master Data", icon: Database, url: "https://md.mes.efortech.id" },
  {
    key: "schedule-maintenance",
    name: "Schedule Maintenance",
    icon: Wrench,
    url: "https://sm.mes.efortech.id",
  },
  {
    key: "job-schedule",
    name: "Job Schedule",
    icon: CalendarDays,
    url: "https://js.mes.efortech.id",
  },
  { key: "oee-monitor", name: "OEE Monitor", icon: Gauge, url: "https://oee.mes.efortech.id" },
];

export const CURRENT_APP_KEY = "oee-monitor";

export const CURRENT_APP = MES_APPS.find((app) => app.key === CURRENT_APP_KEY) ?? MES_APPS[0];
