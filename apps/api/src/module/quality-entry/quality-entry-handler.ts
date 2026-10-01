import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";

import { WebResponse } from "@molca/network";

import { qualityEntryValidator } from "./quality-entry-dto.js";
import { requireActor } from "../../shared/actor.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { QualityEntry, QualityEntryList } from "./quality-entry.js";
import type { QualityEntryService } from "./quality-entry-service.js";
import type { ReportRef } from "./quality-entry-repository.js";
import { requireReportId } from "../../shared/report-id.js";

type QualityEntryHandlerDeps = {
  qualityEntryService: QualityEntryService;
  authMw: AuthMiddleware;
};

// MOUNTED UNDER /work-centers AND /products, never under a prefix of its own.
//
// The routes read `/work-centers/{grain}-reports/:id/quality-entries` and
// `/products/day-reports/:id/quality-entries`, which say what they are: entries
// against a LINE report, or against a SKU one. A top-level /quality-entries would
// have to take the line, the date and the shift as query params and would then be
// a second way to name a report — the argument work-center-handler.ts already
// makes for not serving a bare `/work-centers/:id`.
//
// FOUR PATHS OVER ONE IMPLEMENTATION, like the reads beside them. What the ref
// changes is only which table resolves the id and whether a product is fixed; the
// ENTRY IS ALWAYS SHIFT-KEYED, and what differs is how much each screen has to ask
// for — see quality-entry.ts.
//
// ---------------------------------------------------------------------------
// TWO FACTORIES RATHER THAN ONE WITH A PREFIX PARAMETER, AND IT IS A HAZARD
// ---------------------------------------------------------------------------
//
// One parameterised factory mounted at /products would register
// `/products/shift-reports/:id/quality-entries` as well — a path that resolves a
// LINE report id under a SKU prefix. Seven report tables, seven independent
// identity sequences, so that request answers 200 with some other line's ledger
// and nothing on the wire says it is the wrong subject. Two factories make the
// wrong path unregistrable rather than merely undocumented.
function mountEntryRoutes(
  app: Hono<AuthEnv>,
  pathPrefix: string,
  ref: ReportRef,
  qualityEntryService: QualityEntryService,
) {
  // The ledger. Read by the Losses card's "entered by hand" line and by the
  // entries sheet, which is the one that asks for the voided rows too.
  app.get(`${pathPrefix}/:id/quality-entries`, qualityEntryValidator.list, async (c) => {
    const { includeVoided } = c.req.valid("query");
    const list = await qualityEntryService.list(
      ref,
      requireReportId(c.req.param("id")),
      includeVoided,
    );
    return c.json(WebResponse.builder<QualityEntryList>().data(list).build(), 200);
  });

  // 201, and it RETURNS THE ROW rather than an id.
  //
  // The browser writes it straight into the ledger cache — contract §8's
  // read-after-write rule, the same call the approve endpoints make. It matters
  // more here than there: the entry's CONVERTED quantity is computed by the
  // database from factors the server resolved, so the row is the only place the
  // client can learn what the operator's 10 cartons actually became.
  app.post(`${pathPrefix}/:id/quality-entries`, qualityEntryValidator.create, async (c) => {
    const entry = await qualityEntryService.create(
      ref,
      requireReportId(c.req.param("id")),
      c.req.valid("json"),
      requireActor(c),
    );
    return c.json(WebResponse.builder<QualityEntry>().data(entry).build(), 201);
  });

  // The correction path. A NAMED ROUTE rather than a DELETE, for two reasons:
  // nothing is deleted — 0017's trigger refuses that outright — and a void
  // carries a reason, which a DELETE has nowhere to put.
  app.post(
    `${pathPrefix}/:id/quality-entries/:entryId/void`,
    qualityEntryValidator.void,
    async (c) => {
      const { reason } = c.req.valid("json");
      const entry = await qualityEntryService.void(
        ref,
        requireReportId(c.req.param("id")),
        requireEntryId(c.req.param("entryId")),
        reason ?? null,
        requireActor(c),
      );
      return c.json(WebResponse.builder<QualityEntry>().data(entry).build(), 200);
    },
  );
}

// The LINE trio, at all three grains. Mounted on /work-centers.
function createQualityEntryHandler({ qualityEntryService, authMw }: QualityEntryHandlerDeps) {
  const app = new Hono<AuthEnv>();

  app.use("*", authMw);

  for (const grain of ["shift", "day", "month"] as const) {
    mountEntryRoutes(
      app,
      `/${grain}-reports`,
      { subject: "work-center", grain },
      qualityEntryService,
    );
  }

  return app;
}

// The SKU trio, at the only grain a SKU has. Mounted on /products.
//
// ONE PATH, NO LOOP — oee.product_report_wc_day (0023) is a day table with no
// shift or month sibling, so an empty loop here would send the next reader looking
// for the other two. Same call product-report-handler.ts makes for its reads.
//
// A SKU REPORT SUPPLIES TWO OF THE THREE KEY PARTS and the operator supplies the
// third: the line and the business date come off the row, the SHIFT is named in
// the dialog. That is the line day dialog's arrangement exactly — the entry is
// shift-keyed whatever screen produced it. What is extra here is the PRODUCT,
// which the row also supplies and which the service refuses to let a client
// override; see resolveProductId.
function createProductQualityEntryHandler({
  qualityEntryService,
  authMw,
}: QualityEntryHandlerDeps) {
  const app = new Hono<AuthEnv>();

  app.use("*", authMw);

  mountEntryRoutes(app, "/day-reports", { subject: "product", grain: "day" }, qualityEntryService);

  return app;
}

// SEPARATE FROM requireReportId, and the message is why: these two ids name
// different things and an operator told "report id must be a positive integer"
// while voiding an entry would look for the wrong problem.
function requireEntryId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "entry id must be a positive integer" });
  }
  return id;
}

export { createProductQualityEntryHandler, createQualityEntryHandler };
export type { QualityEntryHandlerDeps };
