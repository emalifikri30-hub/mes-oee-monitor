import { Hono } from "hono";

import { WebResponse, buildPageMeta } from "@molca/network";
import { productReportValidator } from "./product-report-dto.js";
import { requireReportId } from "../../shared/report-id.js";

import type {
  PagedProductReport,
  ProductActivity,
  ProductDowntimeEventBreakdown,
  ProductMachineRoster,
  ProductRejectBreakdown,
  ProductReport,
} from "./product-report.js";
import type { TProductReportService } from "./product-report-service.js";
import type { AuthMiddleware, AuthEnv } from "@molca/mes";

type ProductReportHandlerDeps = {
  productReportService: TProductReportService;
  authMw: AuthMiddleware;
};

// The SKU report — the `Report > SKU > By Day` screens.
//
// NO GRAIN LOOP. work-unit's handler loops over ["day","month"] and
// work-center's over three, because one implementation serves several tables.
// There is one table here (0023) and one grain, so the routes are written out.
// Adding an empty loop now would make the next reader hunt for the other grains.
//
// MOUNTED AT `/products`, beside `/work-units` and `/work-centers` — the subject
// names the prefix. It does not collide with `/master-data/products`: that is the
// SKU CATALOGUE (what a line is set up to run) and this is a MEASUREMENT of what
// it did run, which is the same distinction `/master-data/work-centers` and
// `/work-centers` already keep one subject over.
function createProductReportHandler({ productReportService, authMw }: ProductReportHandlerDeps) {
  const app = new Hono<AuthEnv>();

  app.use("*", authMw);

  app.get("/day-reports", productReportValidator.listReport, async (c) => {
    const { page, size, ...filter } = c.req.valid("query");

    const { items, totalElements } = await productReportService.listReports({
      limit: size,
      offset: (page - 1) * size,
      filter: {
        month: filter.month,
        year: filter.year,
        workCenterId: filter.workCenterId,
        areaId: filter.areaId,
        productId: filter.productId,
        isHideZero: filter.isHideZero,
      },
    });

    return c.json(
      WebResponse.builder<PagedProductReport["items"]>()
        .data(items)
        .meta(buildPageMeta(page, size, totalElements))
        .build(),
      200,
    );
  });

  app.get("/day-reports/:id", async (c) => {
    const report = await productReportService.getReport(requireReportId(c.req.param("id")));

    return c.json(WebResponse.builder<ProductReport>().data(report).build(), 200);
  });

  // The Quality Loss tab.
  app.get("/day-reports/:id/rejects", async (c) => {
    const breakdown = await productReportService.getRejectReasons(
      requireReportId(c.req.param("id")),
    );

    return c.json(WebResponse.builder<ProductRejectBreakdown>().data(breakdown).build(), 200);
  });

  // The Others tab, and the carrier of the unattributed-downtime count.
  app.get("/day-reports/:id/downtime-events", async (c) => {
    const breakdown = await productReportService.getDowntimeEventReasons(
      requireReportId(c.req.param("id")),
    );

    return c.json(
      WebResponse.builder<ProductDowntimeEventBreakdown>().data(breakdown).build(),
      200,
    );
  });

  // The "…" header's Log Activity panel. Two live arms — downtime edits on the
  // stops this SKU owns, and the reject/rework an operator entered against it —
  // plus a named absence where the other six screens have approvals. See
  // getActivity for why the absent arm is REPORTED rather than omitted.
  app.get("/day-reports/:id/activity", async (c) => {
    const activity = await productReportService.getActivity(requireReportId(c.req.param("id")));

    return c.json(WebResponse.builder<ProductActivity>().data(activity).build(), 200);
  });

  // A ROSTER FOR THE REJECT DIALOG'S PROVENANCE PICKER, and NOT the line's
  // /machines — see the note on that path below, and ProductMachineRoster.
  app.get("/day-reports/:id/machines", async (c) => {
    const roster = await productReportService.getMachines(requireReportId(c.req.param("id")));

    return c.json(WebResponse.builder<ProductMachineRoster>().data(roster).build(), 200);
  });

  // WHAT IS DELIBERATELY ABSENT, so the next reader does not go looking:
  //
  //   /products            the report IS one SKU; there is no per-product
  //                        breakdown of a single product.
  //   /performance         no hourly chart on this screen, by requirement. The
  //                        Performance Loss tab renders §61's empty state, the
  //                        same one the line grain shows.
  //   /approve /reopen     oee.work_unit_shift_report_approvals is keyed
  //   /approval            (work_unit_id, date, shift). This grain has neither a
  //                        work unit nor a shift, so there is nothing to key a
  //                        signature on. /activity EXISTS anyway and reports that
  //                        absence as one of its three sources — a feed's other
  //                        two arms are real here even though the approval one
  //                        can never be.
  //
  // AND ONE THAT IS PRESENT BUT NARROWER THAN ITS NAME SUGGESTS. `/machines` here
  // is a ROSTER — which machines reported into this line on this day — for the
  // reject dialog's provenance field. It is NOT the line's per-machine measures
  // BREAKDOWN, and that remains absent for the reason it always was: summing a
  // SKU across a line's machines needs a base-unit conversion these tables cannot
  // supply (§15). Do not "restore" the breakdown onto this path; the payloads are
  // different things.
  //
  // /quality-entries UNDER THIS PREFIX IS SERVED BY ANOTHER MODULE.
  // createProductQualityEntryHandler is mounted on /products beside this handler
  // (cmd/api/app.ts), because an entry is a row in
  // oee.work_center_quality_entries and belongs to the module that owns it.
  return app;
}

export { createProductReportHandler };
