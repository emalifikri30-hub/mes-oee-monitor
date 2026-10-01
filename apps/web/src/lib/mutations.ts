import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  createQualityEntry,
  voidQualityEntry,
  approveLineReport,
  approveShiftReport,
  createDowntimeAction,
  editDowntime,
  reopenLineReport,
  reopenShiftReport,
} from "@/lib/api";
import {
  downtimeActionOptionsKey,
  lineActivityKey,
  qualityEntriesPrefix,
  areaActivityKey,
  skuActivityKey,
  lineApprovalKey,
  lineMetricsStalenessKey,
  metricsStalenessKey,
  periodMetricsStalenessKey,
  periodReportActivityKey,
  shiftReportActivityKey,
  shiftReportQueryOptions,
} from "@/lib/queries";

import type {
  DowntimeActionOption,
  DowntimeEdit,
  LineApprovalSummary,
  QualityEntryDraft,
} from "@/lib/types";
import type { QualityAddress, ReportAddress } from "@/lib/report-subject";

// THE WRITES THIS APP MAKES. The first of them set the conventions below.
//
// WHY THIS IS NOT IN queries.ts
//
// Route loaders import from queries.ts, and nothing in a loader may ever import
// a mutation. A separate module makes that a structural fact rather than a
// review comment — and it keeps queries.ts's import line at
// `{ queryOptions, useQuery }`, which is a one-glance answer to "does this file
// write?".
//
// THREE RULES, EACH A DECISION RATHER THAN A DEFAULT
//
//   1. WRITE THROUGH, THEN INVALIDATE. The approve endpoint returns the updated
//      approval, so setQueryData puts it in the cache synchronously and the
//      badge flips in the same frame the dialog closes. A bare invalidate would
//      leave a stale "Open" badge on screen for one round trip, and
//      docs/gold-write-contract.md §8 is explicit that approvals need
//      read-after-write.
//   2. NO OPTIMISTIC UPDATE. `closedAt` is the server's clock and `closedBy` is
//      the JWT subject; the client cannot produce either without putting a guess
//      on screen. There is no latency problem here to solve — the write is
//      behind a confirm dialog and was benchmarked at 94 ms for a THOUSAND
//      reports (contract §8) — and a rollback path would be code no test ever
//      runs.
//   3. `retry: false`, EXPLICITLY. lib/query-client.ts sets retry:false for
//      QUERIES only; mutations are a separate defaults bucket. A POST is not a
//      GET, and an auto-retried approve is a second write against a report
//      somebody else may have closed in between — which the server answers 409,
//      turning one user's flaky network into a confusing error.
//
// ERRORS ARE DELIBERATELY NOT HANDLED HERE, and there is no global onError. An
// approval failure belongs next to the button that failed, so the user can read
// it and retry in place — which means inside the dialog. See
// approve-report-dialog.tsx. Success is the opposite: nothing to act on, so it
// is a toast.
function useApproveShiftReport(reportId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["approve-shift-report", reportId] as const,
    mutationFn: () => approveShiftReport(reportId),
    retry: false,
    onSuccess: (approval) => {
      // `.queryKey` off the options object, never a hand-written array: the key
      // is typed against the payload, so a drift becomes a type error rather
      // than a cache entry nobody reads.
      const key = shiftReportQueryOptions(reportId).queryKey;

      // A MERGE, not a replace. The endpoint returns only the approval — the
      // report's forty measures are the pipeline's and are not in the payload —
      // so overwriting the entry would blank the whole page. Skipped entirely if
      // nothing is cached: writing a partial object under this key would be
      // worse than a refetch.
      queryClient.setQueryData(key, (current) =>
        current === undefined ? current : { ...current, approval },
      );

      // The approval IS an activity entry, so the feed is now stale. NOT written
      // through: the server owns the entry's id, its prefix and its position in
      // the merge across both arms.
      void queryClient.invalidateQueries({ queryKey: shiftReportActivityKey(reportId) });
      // AND THE FIVE OTHER FEEDS THIS ONE EVENT APPEARS IN. Naming only the key
      // above was complete when the machine shift feed was the only one; it has
      // been a subset since §50 and silently more so since §60. See
      // invalidateApprovalFeeds.
      invalidateApprovalFeeds(queryClient);

      // PREFIX invalidation, and the only place here that needs one.
      // shiftReportsQueryOptions keys on the whole filter object, so there is no
      // single entry to name — every cached page of the By Shift list may now
      // show a stale status badge.
      void queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    },
  });
}

// closed -> open, and the same three rules apply unchanged.
//
// The write-through is the interesting difference: reopening CLEARS all four
// closure columns, so the payload's nulls are the point rather than an absence.
// Merging them over the cached report is what flips the badge back to Open in the
// same frame the dialog closes.
function useReopenShiftReport(reportId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["reopen-shift-report", reportId] as const,
    mutationFn: () => reopenShiftReport(reportId),
    retry: false,
    onSuccess: (approval) => {
      const key = shiftReportQueryOptions(reportId).queryKey;
      queryClient.setQueryData(key, (current) =>
        current === undefined ? current : { ...current, approval },
      );
      // A reopen IS a transition, so the trail has a new row — in six feeds, not
      // one. The same set as the approve above, through the same helper: two call
      // sites naming different subsets is the bug invalidateAfterLineWrite's own
      // header warns about one subject over.
      void queryClient.invalidateQueries({ queryKey: shiftReportActivityKey(reportId) });
      invalidateApprovalFeeds(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    },
  });
}

// Edit one downtime's four mutable fields.
//
// NO WRITE-THROUGH OF THE ROW ITSELF, unlike the two above, and that is the one
// place this mutation departs from them. The endpoint DOES return the updated
// row — but the downtime list is keyed on the whole paging-and-sorting object
// (`["downtimes", params]`), so there is no single entry to name, and a row whose
// `category` just changed may not even belong on the page it is currently
// rendered in. Invalidation is the honest answer; `placeholderData` on that query
// keeps the table on screen while it refetches rather than flashing empty.
//
// WHAT GETS INVALIDATED, AND WHY EACH ONE. All five read the row that just moved:
//
//   downtimes                the detail table on the report
//   downtime-reasons         the Availability / Schedule Loss Pareto — a reason
//                            or category edit moves a bar
//   downtime-reason-detail   the per-reason drill-down behind the eye button
//   downtime-reason-history  the Changes History sheet, which now has a new row
//   shift-report-activity    the report-level Log Activity panel, same reason
//                            (or its line / SKU equivalent — see the switch)
//   metrics-staleness        a CATEGORY edit changes the banner's answer
//
// DELIBERATELY NOT INVALIDATED: shiftReportDowntimeEventsQueryOptions, the Others
// tab. It reads oee.downtime_log_events, which the write contract says this
// service must never write "not even as an operator mutation" — a bar that moves
// when an operator corrects a stop is not a count of anything. That tab holding
// still while the Pareto beside it moves is CORRECT, and refetching it here would
// be the first step toward quietly making it wrong.
//
// PREFIXES, NOT KEYS, for the four downtime queries: each is keyed on its own
// params object, so there is no single entry to name — the same reason the
// approve mutation invalidates `["shift-reports"]` as a prefix.
//
// `refetchType` IS LEFT AT ITS DEFAULT, and that is load-bearing rather than an
// omission. The default refetches only MOUNTED queries and merely marks the rest
// stale, so this fans out to what is on screen and nothing more. The tempting
// "fix" here is `refetchType: "all"`, which would re-request every cached page of
// every Pareto the session has ever opened, after a write behind a dialog.
function useEditDowntime(
  sourceEventId: string | null,
  // WHERE THE OPEN REPORT LIVES — both axes and the id, as one value, so the
  // invalidations below target the key the open screen is actually reading.
  // SEVEN tables with seven independent sequences: a shift-keyed invalidation on
  // a day report clears an entry nobody has, and a MACHINE-keyed one on a line or
  // SKU report clears a stranger's. Either way the feed on screen stays stale and
  // shows the panel the operator just changed as unchanged.
  address: ReportAddress,
) {
  const { subject, grain, id: reportId } = address;
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["edit-downtime", sourceEventId] as const,
    // The null case is unreachable from the UI — the row menu disables Edit for a
    // stop with no id — but the parameter is nullable because the ROW's is, and
    // a `!` here would turn a future regression into a request for
    // /downtimes/null instead of a thrown error at the call site.
    mutationFn: (payload: { next: DowntimeEdit; baseline: DowntimeEdit }) => {
      if (sourceEventId === null) throw new Error("this downtime has no stable id yet");
      return editDowntime(sourceEventId, payload);
    },
    retry: false,
    // An auto-retried PATCH is a second write whose baseline the FIRST attempt
    // may already have invalidated — the server would answer 412 and turn one
    // flaky network into "another user changed this", naming nobody.
    onSuccess: () => {
      for (const prefix of [
        ["downtimes"],
        ["downtime-reasons"],
        ["downtime-reason-detail"],
        ["downtime-reason-history"],
      ]) {
        void queryClient.invalidateQueries({ queryKey: prefix });
      }
      // THE ACTIVITY FEED, at the address on screen. An edit is one of the things
      // that can appear in it, so a stale feed shows the panel the operator just
      // changed as unchanged.
      //
      // A SWITCH ON THE SUBJECT, WITH A `never`, and that shape is the fix rather
      // than the style. This read `subject === "line" ? … : grain === "shift" ? …
      // : period…`, which is correct for TWO subjects and silently wrong at three:
      // a SKU address (`grain: "day"`) fell through to the MACHINE period arm and
      // invalidated a machine's key with a SKU report's id. TODOS §60 wrote the
      // trigger condition for fixing it — "the moment one exists, that arm must be
      // filled in, and nothing will fail if it is not" — and a SKU feed now exists.
      //
      //   machine, any grain   a feed exists per grain (§50 closed both halves).
      //   line, any grain      A FEED EXISTS PER GRAIN NOW, and this arm is the one
      //                        TODOS §60 wrote the trigger condition for: "the
      //                        moment one exists, that arm must be filled in, and
      //                        nothing will fail if it is not." It resolved to
      //                        `null` while the endpoint was shift-only — naming the
      //                        shift key there would have cleared an unrelated line
      //                        SHIFT report's feed, because the three work_center_*
      //                        tables have independent sequences. The key carries
      //                        the grain for exactly that reason.
      //   sku                  one feed, one grain, keyed on the id.
      //   area                 one feed, one grain, keyed on the id. An area day
      //                        report HAS a feed even though it has no approval —
      //                        both its live arms (downtime edits, quality entries)
      //                        are real at this grain, and a downtime edit is
      //                        exactly what this mutation just made.
      const activityKey = ((): readonly unknown[] | null => {
        switch (subject) {
          case "machine":
            return grain === "shift"
              ? shiftReportActivityKey(reportId)
              : periodReportActivityKey(grain, reportId);
          case "line":
            return lineActivityKey(grain, reportId);
          case "sku":
            return skuActivityKey(reportId);
          case "area":
            // BOTH HALVES. The two area tables have independent identity sequences,
            // so an id alone names two feeds — and invalidating the wrong one leaves
            // the panel the operator just changed showing it as unchanged, while
            // refetching a stranger's.
            return areaActivityKey(grain === "month" ? "month" : "day", reportId);
        }
      })();

      if (activityKey !== null) void queryClient.invalidateQueries({ queryKey: activityKey });

      // THE STALENESS BANNER, which mirrors the endpoints rather than being a
      // choice here. §50 gave the machine its day and month readings; the line has
      // one shift-keyed reading and nothing coarser, and a SKU report has NONE —
      // there is no /products/day-reports/:id/metrics-staleness and the screen
      // renders no banner, so there is nothing to refresh. Filed beside §60. An
      // AREA report has none either, for the same reason and filed in the same
      // place — there is no /areas/day-reports/:id/metrics-staleness.
      const stalenessKey = ((): readonly unknown[] | null => {
        switch (subject) {
          case "machine":
            return grain === "shift"
              ? metricsStalenessKey(reportId)
              : periodMetricsStalenessKey(grain, reportId);
          case "line":
            return grain === "shift" ? lineMetricsStalenessKey(reportId) : null;
          case "sku":
            return null;
          case "area":
            return null;
        }
      })();

      if (stalenessKey !== null) void queryClient.invalidateQueries({ queryKey: stalenessKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Part 3 — recording reject and rework by hand
// ---------------------------------------------------------------------------
//
// THE TILE DOES NOT MOVE, and that is the whole reason these two invalidate what
// they invalidate.
//
// The figures on the report are composed by the PIPELINE, through the override
// join in contract §18 — so after a successful entry the Reject tile is exactly
// what it was, and stays that way until the next DAG run. An operator who saw
// nothing change would enter it again, so what MUST refresh is everything that
// reads the LEDGER: the card's "entered by hand" line, the entries sheet, and the
// activity feed.
//
// Deliberately NOT invalidated: the report itself. Refetching it would cost a
// request to prove a number did not change, and would suggest to the next reader
// that it might have.
function useCreateQualityEntry(address: QualityAddress) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["create-quality-entry", address] as const,
    mutationFn: (draft: QualityEntryDraft) => createQualityEntry(address, draft),
    // EXPLICITLY, as everything in this file is. query-client.ts sets retry for
    // QUERIES only, and an auto-retried POST would be a second entry — except
    // that it would not, because `requestId` makes the retry a no-op server-side.
    // It stays off anyway: relying on the idempotency key to cover a retry the
    // client did not intend is relying on a guard for a case it was not added
    // for, and the guard is for a double-CLICK.
    retry: false,
    onSuccess: () => invalidateAfterQualityWrite(queryClient, address),
  });
}

// A correction. Same invalidation set — a void changes the ledger's figures and
// adds a line to the feed, and changes nothing on the report until the pipeline
// runs again.
function useVoidQualityEntry(address: QualityAddress) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["void-quality-entry", address] as const,
    mutationFn: (input: { entryId: number; reason?: string }) =>
      voidQualityEntry(address, input.entryId, input.reason),
    retry: false,
    onSuccess: () => invalidateAfterQualityWrite(queryClient, address),
  });
}

// Shared by both, so a create and a void can never refresh different things —
// the reason invalidateAfterLineWrite exists one feature over.
function invalidateAfterQualityWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  address: QualityAddress,
) {
  // A PREFIX, because the ledger is keyed on `includeVoided` too: the card reads
  // the live list and the sheet reads the full one, and after a write BOTH are
  // wrong. Naming one key would leave whichever is open stale. It comes from
  // queries.ts's own builder rather than being written out here, so the two cannot
  // drift into a write that refreshes nothing.
  void queryClient.invalidateQueries({ queryKey: qualityEntriesPrefix(address) });

  // THE OTHER SUBJECT'S LEDGER TOO, WITHOUT AN ID, and this is the one part worth
  // reading twice.
  //
  // ONE ROW APPEARS IN TWO LEDGERS. An entry recorded from a SKU day report is a
  // row on (line, business_date, shift) with a product — so it belongs in that
  // SKU report's ledger AND in the LINE reports' ledgers covering the same day.
  // Their ids come from different sequences, so the sibling's id is not derivable
  // from this address; a bare prefix is the only thing that can name it.
  //
  // The cost is bounded by `refetchType`'s default, which refetches only MOUNTED
  // queries and merely marks the rest stale — so this fans out to what is on
  // screen and nothing more. The tempting "fix" here is `refetchType: "all"`,
  // which would re-request every ledger the session has ever opened after a write
  // behind a dialog.
  void queryClient.invalidateQueries({
    queryKey:
      address.subject === "sku"
        ? ["work-center-quality-entries"]
        : ["sku-day-report-quality-entries"],
  });

  // THE ACTIVITY FEEDS, on the same argument: an entry is one of the three things
  // that can appear in one, and the sibling subject's feed is as stale as this
  // one's.
  //
  //   line, any grain   its own feed, by GRAIN and id. All three exist now (§60);
  //                     this named only the shift one while that was the only
  //                     endpoint, and the two coarse addresses refreshed nothing.
  //   sku               its own feed, by id.
  //
  // Plus the other subject's prefix, bare, for the two-ledgers reason above. THE
  // LINE PREFIX IS A BARE `work-center-` MATCH, not one of the three keys: an entry
  // recorded from a SKU day report belongs in the LINE's shift, day AND month feeds
  // for that date, and their ids come from three different sequences — so none of
  // them is derivable from a SKU address. TanStack matches a key prefix, and these
  // keys are `work-center-${grain}-report-activity`, which share no common prefix
  // string — so all three are named.
  if (address.subject === "sku") {
    void queryClient.invalidateQueries({ queryKey: skuActivityKey(address.id) });
    for (const grain of LINE_GRAINS) {
      void queryClient.invalidateQueries({ queryKey: [`work-center-${grain}-report-activity`] });
    }
    return;
  }

  void queryClient.invalidateQueries({ queryKey: ["sku-day-report-activity"] });
  void queryClient.invalidateQueries({ queryKey: lineActivityKey(address.grain, address.id) });
}

// The three line grains, for the fan-out above. A literal array rather than a
// widened prefix because there is no shared prefix to widen to — the grain is
// INSIDE each key's first segment, which is what stops a day 7 colliding with a
// shift 7.
const LINE_GRAINS = ["shift", "day", "month"] as const;

// Adds an action to mes-master-data's catalogue, from the Actions picker.
//
// THE ONE MUTATION HERE THAT IS NOT A GOLD WRITE. The other three change
// `oee`; this one changes somebody else's master data through core-api. It lives
// in this file anyway, because the rule this file exists to enforce is about
// WRITES, not about which database they land in — a route loader must not be
// able to import one.
//
// WRITE-THROUGH, unlike the other three, and this is the one place it is clearly
// right. The endpoint returns the whole created row (that is why it returns the
// row and not an id), the cached value is a plain array of exactly those rows,
// and the operator is about to look for what they just typed in the very list
// this key holds. A bare invalidate would leave the picker without it for one
// round trip — during which the obvious thing to do is type it again, which is
// a duplicate the server answers 409.
//
// Invalidated as well as written through: the local append is ordered by
// arrival, upstream orders by `created_at DESC, id ASC`, and the next read
// should be upstream's ordering rather than ours.
//
// `retry: false` for the same reason the other three carry it: a retried create
// is a second row upstream answers 409 on the unique (code, region) key.
function useCreateDowntimeAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["create-downtime-action"] as const,
    mutationFn: createDowntimeAction,
    retry: false,
    onSuccess: (created) => {
      queryClient.setQueryData<DowntimeActionOption[]>(downtimeActionOptionsKey, (current) =>
        // Skipped when nothing is cached, matching useApproveShiftReport: a
        // one-element array written under this key would claim the catalogue
        // holds exactly one action.
        //
        // The `some` guard is not defensive padding — two dialogs open on the
        // same catalogue can both land here for the same row, and a duplicate id
        // would make React key on it twice.
        current === undefined || current.some((option) => option.id === created.id)
          ? current
          : [...current, created],
      );
      void queryClient.invalidateQueries({ queryKey: downtimeActionOptionsKey });
    },
  });
}

// ---------------------------------------------------------------------------
// The line approval — a CASCADE, which changes what has to be invalidated
// ---------------------------------------------------------------------------
//
// Approving a line closes every machine shift report on it. So unlike every other
// write in this file, the rows this changes are mostly NOT the ones the caller is
// looking at: the machine By Shift list and any open machine detail page now hold
// an "Open" badge on a report that has just been signed.
//
// HENCE PREFIX INVALIDATION ACROSS BOTH SUBJECTS. Over-invalidating costs a
// refetch of a list the user may not be on; under-invalidating leaves a wrong
// badge on a signed-off report, which is the failure that matters. The four
// prefixes are spelled out rather than clearing the whole cache, so unrelated
// screens — master data, downtime paretos — are left alone.
//
// WRITE THROUGH FIRST, then invalidate, which is this file's rule and earns its
// keep here: the endpoint returns the counts the Status tile renders, so the tile
// flips in the same frame the dialog closes rather than after a round trip.
//
// `retry: false` for the reason stated at the top of this file, and with more at
// stake than on the machine write: an auto-retried cascade is a second pass over N
// machine reports, which the server answers 409 once they are all closed.
function useApproveLineReport(reportId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["approve-line-report", reportId] as const,
    mutationFn: () => approveLineReport(reportId),
    retry: false,
    onSuccess: (summary: LineApprovalSummary) => {
      queryClient.setQueryData(lineApprovalKey(reportId), summary);
      invalidateAfterLineWrite(queryClient, reportId);
    },
  });
}

function useReopenLineReport(reportId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["reopen-line-report", reportId] as const,
    mutationFn: () => reopenLineReport(reportId),
    retry: false,
    onSuccess: (summary: LineApprovalSummary) => {
      queryClient.setQueryData(lineApprovalKey(reportId), summary);
      invalidateAfterLineWrite(queryClient, reportId);
    },
  });
}

// Shared by both, so the two can never invalidate different sets — a reopen that
// forgot the machine lists would leave "Closed" badges behind, which is the same
// bug pointing the other way.
function invalidateAfterLineWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  reportId: number,
): void {
  // Every feed the cascade's N events can appear in. `lineActivityKey` names this
  // report's own; the other five are prefixes — see invalidateApprovalFeeds.
  void queryClient.invalidateQueries({ queryKey: lineActivityKey("shift", reportId) });
  invalidateApprovalFeeds(queryClient);
  // THE MACHINE SIDE, which is what the cascade actually changed.
  void queryClient.invalidateQueries({ queryKey: ["shift-report"] });
  void queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
  void queryClient.invalidateQueries({ queryKey: ["shift-report-activity"] });
  // And the line lists, whose rows carry no status today but whose measures the
  // pipeline may recompute after an edit.
  void queryClient.invalidateQueries({ queryKey: ["work-center-shift-reports"] });
}

// EVERY ACTIVITY FEED AN APPROVAL TRANSITION CAN APPEAR IN, other than the one the
// caller names by id.
//
// ONE EVENT, SIX FEEDS, and that is the fact this helper exists to hold in one
// place. `oee.work_unit_shift_report_approval_events` is keyed
// (work_unit_id, date, shift), and SIX report screens report a row of it:
//
//   machine shift   its own — named by id at the call site.
//   machine day     its three child shifts' transitions (§50).
//   machine month   the same, over ~90.
//   line shift      a line approval IS N machine approvals, so the line's feed is
//                   the cascade's own events labelled by machine (§53).
//   line day        the same over three shifts and N machines (§60).
//   line month      the same again.
//
// So approving one machine from the machine screen left an open LINE day screen
// showing that transition as not having happened, and vice versa. Neither call
// site could see the whole set, which is why both named a subset: the machine
// writes named one key, the line cascade named two.
//
// PREFIXES, NOT KEYS, AND THEY ARE NOT DERIVABLE. The five coarse feeds are keyed
// on ids from five other identity sequences, and nothing on the address being
// written can produce them — a machine shift report does not know which day report
// covers it, and the line reports are on three sequences again. A prefix is the
// only thing that can name a feed whose id this caller cannot compute.
//
// Bounded by `refetchType`'s default, which refetches only MOUNTED queries and
// merely marks the rest stale — so this reaches whatever is on screen and nothing
// more. The tempting "fix", `refetchType: "all"`, would re-request every feed the
// session has ever opened after a write behind a confirm dialog.
function invalidateApprovalFeeds(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const prefix of [
    // The machine coarse feeds — `${grain}-report-activity`, per
    // periodReportActivityKey.
    ["day-report-activity"],
    ["month-report-activity"],
    // All three line feeds. Their keys carry the grain INSIDE the first segment, so
    // there is no shorter string that matches all three and each has to be named —
    // which is the same property that stops a line day 7 colliding with a shift 7.
    ["work-center-shift-report-activity"],
    ["work-center-day-report-activity"],
    ["work-center-month-report-activity"],
  ]) {
    void queryClient.invalidateQueries({ queryKey: prefix });
  }
}

export {
  useApproveLineReport,
  useApproveShiftReport,
  useCreateDowntimeAction,
  useCreateQualityEntry,
  useEditDowntime,
  useReopenLineReport,
  useReopenShiftReport,
  useVoidQualityEntry,
};
