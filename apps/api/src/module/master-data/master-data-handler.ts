// Read-only reference lists, fronted for the browser.
//
// Request flow:
//
//   BFF ──Bearer(user)──▶ GET /api/v1/master-data/areas
//                              │ authMw                            -> 401
//                              │ (work-centers)    areaId int > 0  -> 400
//                              │ (downtime-reasons) workCenterId   -> 400
//                              │ (POST downtime-actions) body      -> 400
//                              ▼
//                         masterDataService  (5 min ttl, single-flight)
//                              │ fresh / stale ──────────────▶ 200 from memory
//                              ▼ miss
//                         masterDataClient ──Bearer(service)──▶ mes-master-data
//                              │  failed, nothing cached -> 502
//                              ▼
//                         { data: [{id, code, name}], error: null }
//
//   A 200 can now be served from a list known to be OLD, when upstream is down.
//   That is a decided policy, not a leak — see master-data-service.ts.
//
// TWO decisions a reader will want to question, answered here so nobody
// "fixes" them:
//
// 1. THERE IS NOW A master-data-service.ts, and the comment that used to sit
//    here said there deliberately was not — "the port IS the data source and
//    this is a pure passthrough, so a service would be a bare forwarder. The
//    moment a rule appears — scoping areas to the caller's site, hiding work
//    centers with no OEE data, CACHING — it earns a service and this comment
//    goes away."
//
//    Caching is that rule (TODOS.md §7). The handler no longer touches the
//    client, and the 502 mapping moved with it: `upstreamUnavailable` is now
//    raised by the service, on the one path where nothing was ever cached. The
//    502 body is unchanged, because the operation phrases moved too.
//
// 2. The route is /api/v1/master-data/*, not /api/v1/areas. These are NOT this
//    service's resources; mes-master-data owns them and is the only writer.
//    Naming the source of truth in the path keeps anyone from later hanging a
//    POST /api/v1/areas off this service.
//
// The response carries NO `meta`. The client methods return whole lists, a
// select box cannot act on a page count, and a list that outgrew one page is
// reported server-side as master_data_requests_total{outcome="truncated"}.

import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";

import { WebResponse } from "@molca/network";

import { masterDataValidator } from "./master-data-dto.js";

import type { MasterDataServiceContract } from "./master-data-service.js";
import type {
  AreaSummary,
  DowntimeActionSummary,
  DowntimeReasonSummary,
  ProductDetail,
  RejectReasonSummary,
  WorkCenterSummary,
  WorkUnitSummary,
} from "@molca/contract-client";
import type { AuthEnv, AuthMiddleware } from "@molca/mes";

type MasterDataHandlerDeps = {
  masterDataService: MasterDataServiceContract;
  authMw: AuthMiddleware;
};

function createMasterDataHandler({ masterDataService, authMw }: MasterDataHandlerDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  app.get("/areas", async (c) => {
    const areas = await masterDataService.listAreas();

    return c.json(WebResponse.builder<AreaSummary[]>().data(areas).build(), 200);
  });

  app.get("/work-centers", masterDataValidator.listWorkCenter, async (c) => {
    const { areaId } = c.req.valid("query");

    const workCenters = await masterDataService.listWorkCenters(areaId);

    // An area with no work centers is an empty option list, not a 404 — and an
    // unknown areaId is indistinguishable from that upstream, so both answer 200.
    //
    // ONE CONSEQUENCE OF CACHING THAT: an empty list is cached like any other, so
    // a genuinely-unknown areaId is answered from memory for the ttl rather than
    // re-asked. That is correct — it is the same answer either way — and it is
    // what stops a caller walking ?areaId=1..1e6 from becoming upstream traffic.
    return c.json(WebResponse.builder<WorkCenterSummary[]>().data(workCenters).build(), 200);
  });

  // The machines on ONE line, backing the OEE Performance dashboard's machine
  // picker.
  //
  // SCOPED AND REQUIRED, like every other list on this mount: upstream treats a
  // missing workCenterId as "no filter" and answers with the whole region, which
  // here would offer an operator every machine in the plant under a line's label.
  //
  // WHY THIS EXISTS WHEN THE REPORT LIST COULD HAVE SERVED IT. The dashboard needs
  // both an option set and a report id, and taking both from
  // /work-units/month-reports would have cost no new endpoint. It was rejected on
  // what it does to the screen: the machine options would change whenever the month
  // did, and a machine with NO report for the selected month could never be picked,
  // so the screen could never say "this machine has no report for August" — which
  // is the most useful thing it has to tell anybody. A catalogue answers "which
  // machines exist"; a report list answers "which machines ran". The picker wants
  // the first.
  //
  // An empty list is a 200, for the reason /work-centers states above: a line with
  // no machines and an unknown workCenterId are indistinguishable upstream.
  app.get("/work-units", masterDataValidator.listByWorkCenter, async (c) => {
    const { workCenterId } = c.req.valid("query");

    const workUnits = await masterDataService.listWorkUnits(workCenterId);

    return c.json(WebResponse.builder<WorkUnitSummary[]>().data(workUnits).build(), 200);
  });

  // The reason catalogue for ONE line, backing the Reason picker in the browser's
  // downtime edit dialog.
  //
  // WHY THE SCOPE IS A QUERY PARAM AND NOT A PATH SEGMENT. These are not this
  // service's resources — the header above says why the whole mount is
  // /master-data/* — so nesting them under /work-centers/:id/downtime-reasons
  // would model a hierarchy this service does not own. Same call the downtimes
  // resource makes for the same reason.
  //
  // An empty list is a 200: a line with no reasons attached is a valid empty
  // picker, and an unknown workCenterId is indistinguishable from it upstream.
  // The dialog renders "no reasons match" for both, which is the honest answer.
  app.get("/downtime-reasons", masterDataValidator.listDowntimeReason, async (c) => {
    const { workCenterId } = c.req.valid("query");

    const reasons = await masterDataService.listDowntimeReasons(workCenterId);

    return c.json(WebResponse.builder<DowntimeReasonSummary[]>().data(reasons).build(), 200);
  });

  // THE QUALITY-ENTRY DIALOG'S THREE PICKERS.
  //
  // The reject catalogue serves BOTH its Reject and its Rework field — the
  // requirement is explicit that a rework reason IS a reject reason, so there is
  // one route and one cache entry rather than two of each that could drift.
  //
  // SCOPED, like the downtime one and for the same reason. Upstream gained the
  // filter for this caller; before that it answered with the whole region.
  app.get("/reject-reasons", masterDataValidator.listByWorkCenter, async (c) => {
    const { workCenterId } = c.req.valid("query");

    const reasons = await masterDataService.listRejectReasons(workCenterId);

    return c.json(WebResponse.builder<RejectReasonSummary[]>().data(reasons).build(), 200);
  });

  // The SKUs a line is set up to run — a CATALOGUE, not a measurement.
  //
  // Deliberately not sourced from oee.product_count_wc_*, which records what
  // actually ran and ships empty: a picklist answering from that would leave the
  // dialog unusable until Airflow runs, and would make the picker's contents a
  // claim about production rather than about setup.
  app.get("/products", masterDataValidator.listByWorkCenter, async (c) => {
    const { workCenterId } = c.req.valid("query");

    const products = await masterDataService.listLineProducts(workCenterId);

    return c.json(WebResponse.builder<AreaSummary[]>().data(products).build(), 200);
  });

  // ONE product WITH its packages — the unit picker's options AND their
  // conversion factors, which is why the picker cascades from the SKU field
  // rather than offering a global unit list. There is no global uom-to-uom
  // conversion anywhere in this system.
  //
  // 404 rather than an empty object when the id names nothing: a stale picker is
  // a broken request, and the dialog can say so.
  app.get("/products/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new HTTPException(400, { message: "product id must be a positive integer" });
    }

    const product = await masterDataService.getProduct(id);
    if (product === undefined) {
      throw new HTTPException(404, { message: "product not found" });
    }

    return c.json(WebResponse.builder<ProductDetail>().data(product).build(), 200);
  });

  // No scope param, because the action catalogue has none upstream — see
  // DowntimeActionSummary in @molca/contract-client.
  app.get("/downtime-actions", async (c) => {
    const actions = await masterDataService.listDowntimeActions();

    return c.json(WebResponse.builder<DowntimeActionSummary[]>().data(actions).build(), 200);
  });

  // THE ONE WRITE UNDER THIS MOUNT, and it needs a word because decision 2 in the
  // header explicitly forbids hanging a POST off /api/v1/areas.
  //
  // This does not contradict it. That rule is about not letting this service
  // become an owner of someone else's resource — a POST /api/v1/downtime-actions
  // would claim exactly that. Keeping it under /master-data/ says the opposite:
  // the write is FORWARDED, mes-master-data still owns the table and still
  // validates, and the path names whose resource it is.
  //
  // WHY IT EXISTS AT ALL. An operator recording what they did about a stop should
  // not have to leave the dialog, open the master-data app, create the action and
  // come back — they will type it somewhere else instead, and the catalogue stops
  // being the catalogue. Reasons get no equivalent endpoint on purpose: the
  // reason list is curated per line, and a stop that invents one puts a bar on the
  // Availability Pareto that no line owns.
  //
  // 201 with the created row, because the caller needs the NAME back — it is what
  // it writes into the downtime's actions[].
  app.post("/downtime-actions", masterDataValidator.createDowntimeAction, async (c) => {
    const body = c.req.valid("json");

    const created = await masterDataService.createDowntimeAction(body);

    return c.json(WebResponse.builder<DowntimeActionSummary>().data(created).build(), 201);
  });

  return app;
}

export { createMasterDataHandler };
export type { MasterDataHandlerDeps };
