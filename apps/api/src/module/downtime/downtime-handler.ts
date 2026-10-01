import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { WebResponse } from "@molca/network";
import { requireActor } from "../../shared/actor.js";
import { downtimeValidator } from "./downtime-dto.js";
import { isSupportedScope } from "./downtime.js";

import type {
  DowntimeListItem,
  DowntimeReasonBreakdown,
  DowntimeActionBreakdown,
  DowntimeScope,
  ReasonDetail,
  ReasonHistory,
  ReasonSelector,
  ShiftTimeline,
  SupportedScope,
} from "./downtime.js";
import type { DowntimeEditResult, TDowntimeTimelineService } from "./downtime-service.js";
import type { AuthEnv, AuthMiddleware } from "@molca/mes";

type DowntimeHandlerDeps = {
  downtimeTimelineService: TDowntimeTimelineService;
  authMw: AuthMiddleware;
};

// Mounted at /downtimes rather than under /work-units: a downtime belongs to a
// work unit, a work center, an area or the whole factory, and the strip that
// renders it is deliberately scope-agnostic.
function createDowntimeHandler({ downtimeTimelineService, authMw }: DowntimeHandlerDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  // The merged, non-overlapping view: one strip across the whole shift window.
  app.get("/timeline", downtimeValidator.timeline, async (c) => {
    const { scope, scopeId, grain, date, shift, productId } = c.req.valid("query");
    const timeline = await downtimeTimelineService.getTimeline({
      scope: requireSupported(scope),
      scopeId,
      grain,
      date,
      shift,
      productId,
    });

    return c.json(WebResponse.builder<ShiftTimeline>().data(timeline).build(), 200);
  });

  // The raw records behind that strip, paged and sorted. Mounted at the
  // collection root rather than /list: this IS the downtime collection, and the
  // timeline is the derived view of it.
  app.get("/", downtimeValidator.list, async (c) => {
    const { scope, scopeId, grain, date, shift, productId, page, size, sortBy, sortDir } =
      c.req.valid("query");

    const { items, meta } = await downtimeTimelineService.getPagedDowntime(
      page,
      size,
      { scope: requireSupported(scope), scopeId, grain, date, shift, productId },
      { sortBy, sortDir },
    );

    return c.json(WebResponse.builder<DowntimeListItem[]>().data(items).meta(meta).build(), 200);
  });

  // The same records as the two routes above, grouped by their primary reason.
  // Server-side, because a rollup over the paged collection above would
  // aggregate one page and present it as a shift.
  //
  // An OBJECT rather than a bare array, like /work-units/shift-reports/:id/
  // performance and unlike its /products sibling. It carries three things the
  // buckets cannot state about themselves: the window and zone their durations
  // were clipped to, the totals the browser's cumulative line divides by, and
  // `loadedThrough` — which is what separates "this machine ran clean" from
  // "downtime has not loaded yet", the exact ambiguity TODOS.md §8 filed against
  // the timeline strip.
  //
  // `requireSupported` IS called here now. The schema admitted work-unit alone
  // when this route shipped, so the guard could never fire and calling it read as
  // protection that was not doing anything; the schema now admits work-center too
  // (for the Line report's Losses screen), which puts this route back on the same
  // footing as its two siblings.
  //
  // TRUNCATED, AND THE CALLER CHOOSES BY WHAT. `measure` decides which buckets
  // survive `limit`, and both have defaults — so every shipped caller is
  // unaffected and a machine shift, which has far fewer than 20 reasons, sees no
  // change at all. See downtime-dto.ts for the measurements behind those numbers.
  app.get("/by-reason", downtimeValidator.byReason, async (c) => {
    const { scope, scopeId, grain, date, shift, productId, category, measure, limit } =
      c.req.valid("query");

    const breakdown = await downtimeTimelineService.getReasonBreakdown({
      scope: requireSupported(scope),
      scopeId,
      grain,
      date,
      shift,
      productId,
      category,
      measure,
      limit,
    });

    return c.json(WebResponse.builder<DowntimeReasonBreakdown>().data(breakdown).build(), 200);
  });

  // Pareto Actions, on the OEE Performance dashboard: what was DONE about the
  // stops in this window, ranked.
  //
  // A SIBLING OF /by-reason RATHER THAN A MODE OF IT. The two answer adjacent
  // questions over the same rows — why a stop happened, and what somebody did
  // about it — but they do not take the same parameters: this one has no
  // `category`, because an action is not an operation type. A shared route with an
  // optional category would make that absence look like a caller's oversight.
  //
  // It has no `/detail` sibling. The reason Pareto's eye button opens the stops
  // behind one bucket; nothing on the dashboard drills in yet, and a drill-down
  // nobody opens is a second copy of the selector plumbing to keep in step.
  app.get("/by-action", downtimeValidator.byAction, async (c) => {
    const { scope, scopeId, grain, date, shift, productId, measure, limit } = c.req.valid("query");

    const breakdown = await downtimeTimelineService.getActionBreakdown({
      scope: requireSupported(scope),
      scopeId,
      grain,
      date,
      shift,
      productId,
      measure,
      limit,
    });

    return c.json(WebResponse.builder<DowntimeActionBreakdown>().data(breakdown).build(), 200);
  });

  // ONE bucket of the breakdown above, plus the stops inside it. What the
  // Pareto's eye button opens.
  //
  // Nested under /by-reason rather than mounted as a sibling: it is a drill-down
  // INTO one of that route's buckets, takes the same scope/date/shift/category
  // identity, and is meaningless without it. A flat /downtimes/reason-detail
  // would hide that relationship from anyone reading the route table.
  //
  // Paged, unlike /by-reason. The aggregate is bounded by the number of distinct
  // reasons in a shift; the records behind ONE reason are not.
  app.get("/by-reason/detail", downtimeValidator.reasonDetail, async (c) => {
    const {
      scope,
      scopeId,
      grain,
      date,
      shift,
      // NAMED EXPLICITLY, AND IT HAS TO BE. `...selector` collects whatever is
      // left, so a field added to the schema and not destructured here lands in
      // the reason selector and is handed to `toSelector` — which would either
      // widen a selector nobody meant or narrow the drill-down by a field it does
      // not understand. A rest spread makes every new query param this route's
      // business by default.
      productId,
      category,
      page,
      size,
      sortBy,
      sortDir,
      ...selector
    } = c.req.valid("query");

    const { detail, meta } = await downtimeTimelineService.getReasonDetail(page, size, {
      scope,
      scopeId,
      grain,
      date,
      shift,
      productId,
      category,
      selector: toSelector(selector),
      sortBy,
      sortDir,
    });

    return c.json(WebResponse.builder<ReasonDetail>().data(detail).meta(meta).build(), 200);
  });

  // The Changes History panel. Unpaged — a chronology, not a table.
  //
  // Returns 200 with an empty `entries` today and will for as long as the
  // downtime-edit write path does not exist (TODOS.md §21). That is not an
  // error, and the payload says WHY it is empty rather than leaving the browser
  // to guess: see `trackedMembers` on ReasonHistory.
  app.get("/by-reason/history", downtimeValidator.reasonHistory, async (c) => {
    // `productId` named before the rest spread, for the reason /by-reason/detail records.
    const { scope, scopeId, grain, date, shift, productId, category, ...selector } =
      c.req.valid("query");

    const history = await downtimeTimelineService.getReasonHistory({
      scope,
      scopeId,
      grain,
      date,
      shift,
      productId,
      category,
      selector: toSelector(selector),
    });

    return c.json(WebResponse.builder<ReasonHistory>().data(history).build(), 200);
  });

  // EDIT ONE STOP — the second of the two named operator mutations
  // docs/gold-write-contract.md §1 rule 2 reserves for this service.
  //
  // PATCH rather than POST /:id/edit, and unlike /shift-reports/:id/approve, and
  // the difference is real rather than stylistic. `approve` names a TRANSITION —
  // one of two, in a state machine, where a general setter would publish the other
  // one the moment it existed. This is not a transition: it is an update of four
  // named columns on a resource, with no state machine and no second verb hiding
  // in it. PATCH is what that is.
  //
  // KEYED ON source_event_id, NOT on `id`. Contract §2.1 loads
  // oee.downtime_reports DELETE-then-INSERT, so the surrogate serial is re-minted
  // on every pipeline run and a URL built from it would come to address a
  // different stop. It is also why oee.downtime_report_history keys on this
  // column, and it is why this route 404s for every stop today: the pipeline does
  // not write source_event_id yet (TODOS.md §19), so the browser disables Edit for
  // a row that has none rather than offering an action that cannot work.
  //
  // A PATH SEGMENT, so it is percent-decoded by Hono. The column is free text
  // from Silver, and a deterministic id containing a slash would break this —
  // the ids the pipeline is asked for in contract §3.3.2 do not, and a stop whose
  // id did would simply 404 rather than address the wrong row.
  //
  // THE BODY CARRIES BOTH the new values and the ones the dialog was showing. See
  // EditDowntimeInput: the baseline is the optimistic-concurrency token, and the
  // table has no version column to use instead.
  //
  // 200 WITH THE UPDATED ROW, not 204. The detail table writes the row through its
  // cache rather than refetching the page it is standing on — the same
  // read-after-write argument contract §8 makes for approvals.
  app.patch("/:sourceEventId", downtimeValidator.edit, async (c) => {
    const { next, baseline } = c.req.valid("json");

    const result = await downtimeTimelineService.editDowntime({
      sourceEventId: requireSourceEventId(c.req.param("sourceEventId")),
      next,
      baseline,
      actor: requireActor(c),
    });

    return c.json(WebResponse.builder<DowntimeEditResult>().data(result).build(), 200);
  });

  return app;
}

// The two validated query params collapse into the domain's discriminated
// union. The schema has already guaranteed exactly one is set, so the `reason`
// branch cannot be reached with an undefined reason — but the check is written
// out rather than asserted, because a `!` here would be the one place a schema
// change could turn into a runtime undefined with no compiler complaint.
function toSelector({
  reason,
  unlabelled,
}: {
  reason?: string;
  unlabelled: boolean;
}): ReasonSelector {
  if (unlabelled || reason === undefined) return { kind: "unlabelled" };
  return { kind: "labelled", reason };
}

// The stop's public identity, from the path.
//
// A GUARD RATHER THAN A PASS-THROUGH, even though the column is free text and
// almost any string is a legitimate value. An empty segment cannot reach here —
// Hono would not match the route — but a whitespace-only one can, and it would
// reach the repository as a value that matches no row and 404s, which is the same
// answer for a very different reason. Trimming makes the two the same case.
//
// No format check beyond that, deliberately: contract §3.3.2 asks the pipeline
// for "a deterministic id carried from the Silver event" and does not constrain
// its shape, so validating one here would be this service inventing a rule the
// producer never agreed to.
function requireSourceEventId(raw: string | undefined): string {
  const id = raw?.trim() ?? "";
  if (id === "") {
    throw new HTTPException(400, { message: "downtime id must not be empty" });
  }
  return id;
}

// `area` and `factory` are part of the contract but not yet served —
// oee.downtime_reports carries no area_id / factory_id, so answering them means
// resolving the hierarchy through mes-master-data first. A 400 that says so
// beats a 200 with a silently empty result.
//
// Shared by both routes so the two can never disagree about what is servable.
function requireSupported(scope: DowntimeScope): SupportedScope {
  if (!isSupportedScope(scope)) {
    throw new HTTPException(400, {
      message: `scope "${scope}" is not supported yet; use work-unit or work-center`,
    });
  }
  return scope;
}

export { createDowntimeHandler };
export type { DowntimeHandlerDeps };
