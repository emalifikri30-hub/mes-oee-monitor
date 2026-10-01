import { metrics } from "@opentelemetry/api";

import type { Counter, Histogram } from "@opentelemetry/api";

// Custom metrics are resolved lazily so they bind to the real MeterProvider
// installed by the OTel SDK — creating an instrument before the SDK starts binds
// it to the no-op provider permanently.

// Outbound calls to mes-master-data.
//
// Traces already cover the happy path — UndiciInstrumentation emits a CLIENT
// span for every fetch — but a span cannot be alerted on cheaply, and one of
// these failure modes is INVISIBLE over HTTP: when enrichment fails the request
// still returns 200 with null labels. `outcome` is the only signal that a report
// has been silently degraded, so it is a counter, not just a log line.
//
//   outcome = ok | timeout | network_error | http_error | auth_error | parse_error
//           | degraded   -- enrichment failed; the request succeeded anyway
//           | truncated  -- the work-unit page loop hit its cap
//
// THE `// Alert on:` LINES ARE NO LONGER ONLY COMMENTS. Every one of them is now
// a real rule in `prometheus-alerts.yml`, evaluated by the Prometheus in
// docker-compose.yml and drawn by the Grafana dashboard beside it
// (grafana/dashboards/oee-service.json). TODOS.md §39 was the entry.
//
// SO KEEP THEM IN STEP. Adding an instrument with an `// Alert on:` line and not
// adding the rule puts this file back to describing an alerting design nobody
// implemented, which is what §39 existed to fix.
//
// One caveat that bit the first attempt: a HISTOGRAM is exported as _bucket /
// _count / _sum, so its annotation must name the bucket series. Counters keep
// their names exactly, `_total` suffix included.

// Alert on: rate(master_data_requests_total{outcome!="ok"}[5m]) > 0
let masterDataRequests: Counter | undefined;

function getMasterDataRequestsCounter(): Counter {
  masterDataRequests ??= metrics.getMeter("core-api").createCounter("master_data_requests_total", {
    description: "Outbound requests to mes-master-data, labelled by operation and outcome",
  });
  return masterDataRequests;
}

let masterDataDuration: Histogram | undefined;

function getMasterDataDurationHistogram(): Histogram {
  masterDataDuration ??= metrics
    .getMeter("core-api")
    .createHistogram("master_data_request_duration_ms", {
      description: "Latency of outbound requests to mes-master-data",
      unit: "ms",
    });
  return masterDataDuration;
}

// Downtime timeline shape.
//
// Both of these exist because the interesting failures are invisible over HTTP:
// the request answers 200 either way.
//
//   downtime_timeline_segments   — how many segments a merged shift produced.
//     Every segment is a DOM node with a tooltip trigger, so a runaway ETL that
//     emits per-minute stops shows up here before it shows up as a slow page.
//
//   downtime_rows_dropped_total  — rows discarded by the sweep because their
//     clipped interval came out empty. A non-zero rate means the data is wrong,
//     not the endpoint.
//
//     ITS MEANING NARROWED ON 2026-09-02 AND THE ALERT IS WEAKER THAN IT READS.
//     It used to catch INVERTED rows (end_at < start_at) too, because the
//     membership predicate returned them and the sweep threw them away. TODOS.md
//     §10/§69 replaced that predicate with a range `&&` matching
//     dt_reports_span_gist, whose `greatest(...)` collapses an inverted row to an
//     EMPTY range — so those rows are now filtered in Postgres and never reach
//     the sweep to be counted.
//
//     What is LEFT is the genuinely-empty clip: an open stop in a window that has
//     not started yet, where coalesce(end_at, now) lands before the window's
//     `from`. Real, and much rarer. So a ZERO rate here no longer means "no
//     malformed rows" — it means "none that the timeline tripped over".
//     Detecting inverted rows is a data-quality question about the whole table
//     and never should have been a side effect of drawing one shift's strip;
//     TODOS.md §70 carries the replacement.
//
// Alert on: rate(downtime_rows_dropped_total[15m]) > 0
let downtimeSegments: Histogram | undefined;

function getDowntimeSegmentsHistogram(): Histogram {
  downtimeSegments ??= metrics.getMeter("core-api").createHistogram("downtime_timeline_segments", {
    description: "Segments in a merged downtime timeline, labelled by scope",
  });
  return downtimeSegments;
}

let downtimeRowsDropped: Counter | undefined;

function getDowntimeRowsDroppedCounter(): Counter {
  downtimeRowsDropped ??= metrics
    .getMeter("core-api")
    .createCounter("downtime_rows_dropped_total", {
      description:
        "Downtime rows discarded by the sweep or the reason aggregate for having an empty or inverted interval",
    });
  return downtimeRowsDropped;
}

// Time-zone resolution through the master-data hierarchy.
//
// Same reasoning as the two above, in its sharpest form: the dangerous failure
// here is INVISIBLE over HTTP. When resolution fails, the resolver serves the
// last known good zone and the request answers 200 with entirely plausible
// times — so a plant could read a frozen zone for a week with nothing in the
// response to say so. `outcome` is the only signal that has happened.
//
//   outcome = hit            -- served fresh from cache
//           | miss           -- fetched from upstream
//           | stale          -- upstream failed; served the last known good value
//           | stale_backoff  -- still stale, re-fetch suppressed by the backoff
//           | failed         -- upstream failed and nothing was ever cached
//
// Alert on: rate(time_zone_resolutions_total{outcome="failed"}[5m]) > 0
//       and rate(time_zone_resolutions_total{outcome=~"stale.*"}[15m]) > 0
let timeZoneResolutions: Counter | undefined;

function getTimeZoneResolutionsCounter(): Counter {
  timeZoneResolutions ??= metrics
    .getMeter("core-api")
    .createCounter("time_zone_resolutions_total", {
      description: "Time-zone resolutions by scope and cache outcome",
    });
  return timeZoneResolutions;
}

// Per-SKU output on a shift report.
//
// Same invisible-over-HTTP problem, one step further: an existing shift report
// with no rows in oee.product_count_wu_shift answers 200 with an empty list, and
// the card renders "No product output recorded for this shift" — which is exactly
// what a genuinely idle machine renders. These two instruments are the only way to
// tell those apart from outside.
//
//   product_count_empty_total  — a report that EXISTS but has no product rows.
//     Deliberately not incremented for an unknown report id: that is a bad
//     request, not a data gap, and counting it would drown the signal.
//
//   product_count_rows         — rows returned per request. The endpoint is
//     unpaged on the argument that one machine runs a handful of SKUs per shift;
//     this is the instrument that says when that stops being true.
//
// BOTH CARRY A `grain` ATTRIBUTE ON THE COARSE PATHS AND NONE ON THE SHIFT ONE.
// That asymmetry is deliberate rather than an omission: adding a label to the
// shift emission would change an existing series' identity and break continuity
// on every dashboard already reading it. Absent means shift.
//
// The label is what tells a paged engineer WHICH TABLE to open —
// oee.product_count_wu_shift for the shift path, oee.product_count_wu_day for
// both coarse ones — and the alert annotation says so.
//
// Alert on: rate(product_count_empty_total[1h]) > 0
let productCountEmpty: Counter | undefined;

function getProductCountEmptyCounter(): Counter {
  productCountEmpty ??= metrics.getMeter("core-api").createCounter("product_count_empty_total", {
    description:
      "Reports that exist but have no product rows (product_count_wu_shift, or _day at the coarser grains)",
  });
  return productCountEmpty;
}

let productCountRows: Histogram | undefined;

function getProductCountRowsHistogram(): Histogram {
  productCountRows ??= metrics.getMeter("core-api").createHistogram("product_count_rows", {
    description: "Product rows returned for one report; `grain` is absent at shift grain",
  });
  return productCountRows;
}

// oee.product_perf_wu_hour — the hourly performance chart behind the Losses card.
//
//   perf_hour_empty_total  — a shift report that EXISTS but has no hourly rows.
//     Same rule as product_count_empty_total: NOT incremented for an unknown
//     report id, which is a bad request rather than a data gap.
//
//     Unlike the SKU card, the browser can now usually tell WHY it is empty — the
//     response carries oee.etl_watermarks.last_business_date, so "not loaded yet"
//     and "the machine idled" render differently. This counter is still worth
//     having: it is the outside view, and it fires even when nobody has the screen
//     open.
//
//   perf_hour_points       — rows returned per request. The endpoint is unpaged on
//     the argument that a shift is 8 buckets times a handful of SKUs.
//
//     THE DAY GRAIN NOW SHARES THIS HANDLER, at 24 buckets, and carries
//     `grain="day"` precisely so the two populations do not merge into one
//     bimodal distribution nobody can read. Month is still refused outright —
//     ~720 buckets is the case this comment was written to warn about, and
//     getPeriodPerformance 404s it rather than serving an unreadable chart.
//
// Alert on: rate(perf_hour_empty_total[1h]) > 0
let perfHourEmpty: Counter | undefined;

function getPerfHourEmptyCounter(): Counter {
  perfHourEmpty ??= metrics.getMeter("core-api").createCounter("perf_hour_empty_total", {
    description: "Reports that exist but have no rows in oee.product_perf_wu_hour",
  });
  return perfHourEmpty;
}

let perfHourPoints: Histogram | undefined;

function getPerfHourPointsHistogram(): Histogram {
  perfHourPoints ??= metrics.getMeter("core-api").createHistogram("perf_hour_points", {
    description: "Hourly performance rows returned for one report; 8 at shift grain, 24 at day",
  });
  return perfHourPoints;
}

// oee.downtime_reports grouped by primary reason — the Availability Loss tab.
//
// The endpoint is unpaged, has no LIMIT and no "Other" bucket, on the argument
// that one machine accumulates a handful of distinct reasons in one shift. This
// is the instrument that says when that stops being true. It is also the first
// warning if a wider scope is ever pointed at the handler, which is the query
// docs/gold-write-contract.md §8 measured at 2.8 s for a plant-year.
//
// There is deliberately no matching downtime_reason_empty_total counter — see
// getReasonBreakdown in downtime-service.ts for why.
//
// Alert on: histogram_quantile(0.99, sum by (le) (rate(downtime_reason_groups_bucket[30m]))) > 50
//
// NOTE THE `_bucket` AND THE `sum by (le)`. This annotation used to read
// `histogram_quantile(0.99, downtime_reason_groups)`, which is not runnable
// PromQL: the collector's prometheus exporter turns one histogram into three
// series — _bucket, _count and _sum — and a quantile needs the bucket vector
// grouped by `le`. Counters, by contrast, pass through unchanged, so their
// annotations below were already correct. Verified by emitting one sample of
// each instrument and reading :8889/metrics.
let downtimeReasonGroups: Histogram | undefined;

function getDowntimeReasonGroupsHistogram(): Histogram {
  downtimeReasonGroups ??= metrics.getMeter("core-api").createHistogram("downtime_reason_groups", {
    description: "Distinct downtime reasons returned for one shift breakdown",
  });
  return downtimeReasonGroups;
}

// oee.reject_count_wu_shift grouped by counter — the Quality Loss tab.
//
// READ THE ALERTING NOTE BEFORE WIRING THESE UP. The table ships EMPTY: nothing
// writes it until the `work_unit_*` DAG does (docs/gold-write-contract.md §3.8),
// so reject_reason_empty_total fires on EVERY request today. That is the honest
// reading of the world and not an anomaly, which is why it must not be alerted on
// until the pipeline lands. Once it does, the alert below becomes meaningful
// unchanged — the counter's meaning never shifts, only the expected rate.
//
//   reject_reason_empty_total  — a shift report that EXISTS but has no reject
//     rows. NOT incremented for an unknown report id: that is a bad request
//     rather than a data gap, and counting it would drown the signal. Same rule
//     as product_count_empty_total and perf_hour_empty_total.
//
//   reject_reason_groups       — distinct counters returned per request. The
//     endpoint is unpaged, has no LIMIT and no "Other" bucket, on the argument
//     that one machine has a handful of reject counters wired to it. This is the
//     instrument that says when that stops being true — and it is the first
//     warning if this handler is ever pointed at a wider scope, which is the
//     narrowing TODOS.md §25 is about for the downtime sibling.
//
// Alert on (AFTER the DAG ships): rate(reject_reason_empty_total[1h]) > 0
let rejectReasonEmpty: Counter | undefined;

function getRejectReasonEmptyCounter(): Counter {
  rejectReasonEmpty ??= metrics.getMeter("core-api").createCounter("reject_reason_empty_total", {
    description: "Shift reports that exist but have no rows in oee.reject_count_wu_shift",
  });
  return rejectReasonEmpty;
}

let rejectReasonGroups: Histogram | undefined;

function getRejectReasonGroupsHistogram(): Histogram {
  rejectReasonGroups ??= metrics.getMeter("core-api").createHistogram("reject_reason_groups", {
    description: "Distinct reject counters returned for one shift report",
  });
  return rejectReasonGroups;
}

// oee.downtime_log_events exploded by reason — the Others tab.
//
// SAME ALERTING NOTE AS THE PAIR ABOVE, for the same reason. The table ships
// EMPTY: nothing writes it until the `work_unit_*` DAG does
// (docs/gold-write-contract.md §3.9), so downtime_event_empty_total fires on
// EVERY request today. That is the honest reading of the world rather than an
// anomaly, so it must not be alerted on until the pipeline lands — and once it
// does, the alert below becomes meaningful unchanged, because the counter's
// meaning never shifts, only its expected rate.
//
//   downtime_event_empty_total  — a shift report that EXISTS but has no logged
//     events. NOT incremented for an unknown report id: that is a bad request
//     rather than a data gap, and counting it would drown the signal. Same rule
//     as product_count_empty_total, perf_hour_empty_total and
//     reject_reason_empty_total.
//
//   downtime_event_groups       — distinct reasons returned per request. The
//     endpoint is unpaged, has no LIMIT and no "Other" tail bucket, on the
//     argument that one machine's stops in one shift cite a handful of reasons.
//     This is the instrument that says when that stops being true, and the first
//     warning if this handler is ever pointed at a wider scope — the narrowing
//     TODOS.md §25 is about for the downtime sibling.
//
// A NAMING WARNING, because these two are one word away from three others. They
// count oee.downtime_log_events and have NOTHING to do with
// downtime_reason_groups, downtime_timeline_segments or
// downtime_rows_dropped_total, which all read oee.downtime_reports. The two
// families describe the same physical stops through an immutable source and an
// operator-mutable one, so summing them in a dashboard is meaningless —
// contract §3.9's second dbt test exists precisely because nobody yet knows how
// far apart they are.
//
// Alert on (AFTER the DAG ships): rate(downtime_event_empty_total[1h]) > 0
let downtimeEventEmpty: Counter | undefined;

function getDowntimeEventEmptyCounter(): Counter {
  downtimeEventEmpty ??= metrics.getMeter("core-api").createCounter("downtime_event_empty_total", {
    description: "Shift reports that exist but have no rows in oee.downtime_log_events",
  });
  return downtimeEventEmpty;
}

let downtimeEventGroups: Histogram | undefined;

function getDowntimeEventGroupsHistogram(): Histogram {
  downtimeEventGroups ??= metrics.getMeter("core-api").createHistogram("downtime_event_groups", {
    description: "Distinct downtime reasons returned for one shift report",
  });
  return downtimeEventGroups;
}

// ---------------------------------------------------------------------------
// The master-data reference-list cache
// ---------------------------------------------------------------------------
//
//   master_data_cache_total{list, outcome}  — one increment per lookup of the
//     areas or work-centers list. `outcome` is the branch shared/stale-cache.ts
//     took: hit, miss, stale, stale_backoff, failed.
//
// WHY THIS IS NOT master_data_requests_total. That counter records what crossed
// the WIRE, and the whole point of the cache is that most lookups no longer do —
// so after TODOS.md §7 a falling request rate is the cache working, not traffic
// disappearing. These two answer different questions and neither substitutes.
//
// `outcome="stale"` IS THE ONE TO WATCH, and it is invisible to every other
// signal. It means upstream is down and a filter is being drawn from a list of
// known-old data: the request SUCCEEDS, the status is 200, nothing is logged as
// an error, and the dropdown may offer a work center that has since been renamed
// or removed. `master_data_requests_total{outcome!="ok"}` catches the upstream
// failure, but only this says a USER was shown the consequence.
//
// `outcome="stale_backoff"` is the healthy shape of the same outage — the backoff
// suppressing repeat attempts — so it is expected to dwarf "stale" during one.
// A high stale_backoff with zero stale would mean the backoff is armed and
// nothing is asking, which is fine.
//
// DELIBERATELY NOT COUNTED: cache size or eviction. The real universe is 3 areas
// plus their work centers, so maxEntries exists as a bound rather than as
// something to tune, and a gauge nobody can act on is noise.
//
// Alert on: rate(master_data_cache_total{outcome="stale"}[15m]) > 0
// Alert on: rate(master_data_cache_total{outcome="failed"}[5m]) > 0
let masterDataCache: Counter | undefined;

function getMasterDataCacheCounter(): Counter {
  masterDataCache ??= metrics.getMeter("core-api").createCounter("master_data_cache_total", {
    description: "Reference-list lookups, by list and cache outcome",
  });
  return masterDataCache;
}

// ---------------------------------------------------------------------------
// Approval transitions, and the downtime edit — the writes this service makes
// ---------------------------------------------------------------------------
//
//   shift_report_transitions_total{to, source}  — successful transitions.
//     `to` is `closed` for an approve and `open` for a reopen; `source` is
//     `operator` today and will be `system` when the 14-day sweeper lands
//     (TODOS.md §31).
//
//   shift_report_transition_conflicts_total{to}  — transitions rejected with a
//     409 because the report was already in the state being asked for.
//
//   downtime_edits_total{field}  — fields actually changed by an operator edit.
//     One increment PER CHANGED FIELD, so a single edit touching category and
//     actions counts two — which is exactly the grain
//     oee.downtime_report_history is written at, so the counter and the trail
//     can be reconciled.
//
//   downtime_edit_conflicts_total{cause}  — edits refused. `cause` is `approved`
//     for a 409 against a signed-off report, `concurrent` for a 412 where another
//     operator got there first, and `restated` for a 412 where the PIPELINE
//     rebuilt the row underneath the dialog.
//
// RENAMED FROM shift_report_approvals_total / shift_report_approve_conflicts_total,
// which named one of the two directions they now cover. Free to do today because
// nothing consumes them yet — there is no Grafana in this repo at all — and this
// is the shape the old comment was already reaching for when it argued for a
// `source` label rather than a second counter. When §31's sweeper lands it needs
// no new instrument: it is {to: 'closed', source: 'system'}.
//
// THE CONFLICT COUNTERS ARE THE ONES THAT EARN THEIR KEEP, and their signal is
// not "users double-click". A 409 means the browser offered an action that was
// not available, which is a STALE CACHE — and the server answers it perfectly
// correctly, logs nothing alarming, and looks entirely healthy. It is the same
// shape of invisible defect product_count_empty_total exists for.
//
// `downtime_edit_conflicts_total{cause="restated"}` is the sharpest of them: it
// means the pipeline reloaded a stop while somebody was editing it, which is the
// one situation where the operator's next action — retry — would silently
// overwrite a fresh upstream correction. A non-zero rate here is an argument for
// the recalculation trigger, not for a wider retry.
//
// DELIBERATELY NOT COUNTED: 404s. A bad report id or an unknown source_event_id
// is a bad request, not a data gap, and counting it would drown the signals above
// — the identical rule getProductCountEmptyCounter states for its own 404 path.
//
// ALSO DELIBERATELY NOT COUNTED: a no-op edit. An edit whose diff is empty writes
// no history row, so counting it here would make this counter disagree with the
// table it is supposed to mirror.
//
// Alert on: rate(shift_report_transition_conflicts_total[1h]) > 0
// Alert on: rate(downtime_edit_conflicts_total{cause="restated"}[1h]) > 0
let shiftReportTransitions: Counter | undefined;

function getShiftReportTransitionsCounter(): Counter {
  shiftReportTransitions ??= metrics
    .getMeter("core-api")
    .createCounter("shift_report_transitions_total", {
      description: "Work-unit shift report approval transitions, by direction and actor",
    });
  return shiftReportTransitions;
}

let shiftReportTransitionConflicts: Counter | undefined;

function getShiftReportTransitionConflictsCounter(): Counter {
  shiftReportTransitionConflicts ??= metrics
    .getMeter("core-api")
    .createCounter("shift_report_transition_conflicts_total", {
      description: "Transition attempts rejected because the report was already in that state",
    });
  return shiftReportTransitionConflicts;
}

// THE INSTRUMENT THAT MAKES §34's ROLLOUT SURVIVABLE, and the reason it exists is
// stated in that entry: a role gate turned on before Keycloak emits the role
// "would be discovered in production". This is how it gets discovered in a minute
// instead of a support call.
//
// The failure is quiet by construction. A wrong role name breaks ONLY the three
// write paths — every read keeps working, every page renders, and the OEE numbers
// are right. An operator finds out at the end of a shift, when the Approve button
// starts returning 403 and there is nothing else to try.
//
// Labelled by `action` and NOT by subject or role name: a per-operator label is
// unbounded cardinality, and the role name is already known to whoever set the
// variable. What is not known is which mutation they just locked.
//
// A NON-ZERO RATE IS NOT AUTOMATICALLY A FAULT — once a gate is deliberately on,
// refusing somebody without the role IS the gate working. It is the SHAPE that
// matters: every attempt on one action refused while none succeeds means the role
// name is wrong, whereas denials alongside successes mean somebody without access
// tried. Only the first is an incident.
//
// WHICH IS WHY THERE IS A GRANTS COUNTER BESIDE THIS ONE, and the reason is worth
// recording because the obvious alternative does not work. Expressing "refused and
// nothing succeeded" needs a success signal carrying the SAME `action` label, and
// no existing metric has one: shift_report_transitions_total is {to, source} and
// downtime_edits_total is {field}. `sum by (action)` over either produces a series
// with NO action label, which cannot cancel a labelled one — verified against a
// live Prometheus, where
//
//   label_replace(vector(1),"action","approve","","") unless on (action) vector(1)
//
// returns the series rather than nothing. An alert built that way would have fired
// CRITICAL on every ordinary denial while looking perfectly reasonable in review.
//
// Alert on: sum by (action) (rate(operator_authorization_denials_total[15m])) > 0
//           unless on (action) sum by (action) (rate(operator_authorization_grants_total[15m])) > 0
// Alert on: rate(operator_authorization_denials_total[1h]) > 0
let operatorAuthorizationDenials: Counter | undefined;

function getOperatorAuthorizationDenialsCounter(): Counter {
  operatorAuthorizationDenials ??= metrics
    .getMeter("core-api")
    .createCounter("operator_authorization_denials_total", {
      description: "Operator mutations refused because the token lacked the configured role",
    });
  return operatorAuthorizationDenials;
}

// The denominator for the rule above, and ONLY counted when a gate is actually
// enabled. An ungated mutation increments nothing — otherwise every deployment
// today would report grants for gates that are not switched on, and "is this gate
// in use?" would have no answer.
let operatorAuthorizationGrants: Counter | undefined;

function getOperatorAuthorizationGrantsCounter(): Counter {
  operatorAuthorizationGrants ??= metrics
    .getMeter("core-api")
    .createCounter("operator_authorization_grants_total", {
      description: "Operator mutations allowed by an ENABLED role gate, by action",
    });
  return operatorAuthorizationGrants;
}

let downtimeEdits: Counter | undefined;

function getDowntimeEditsCounter(): Counter {
  downtimeEdits ??= metrics.getMeter("core-api").createCounter("downtime_edits_total", {
    description: "Downtime fields changed by an operator edit, one per changed field",
  });
  return downtimeEdits;
}

let downtimeEditConflicts: Counter | undefined;

function getDowntimeEditConflictsCounter(): Counter {
  downtimeEditConflicts ??= metrics
    .getMeter("core-api")
    .createCounter("downtime_edit_conflicts_total", {
      description: "Downtime edits refused, by cause",
    });
  return downtimeEditConflicts;
}

export {
  getDowntimeEventEmptyCounter,
  getDowntimeEventGroupsHistogram,
  getDowntimeReasonGroupsHistogram,
  getDowntimeRowsDroppedCounter,
  getDowntimeSegmentsHistogram,
  getMasterDataCacheCounter,
  getMasterDataRequestsCounter,
  getMasterDataDurationHistogram,
  getPerfHourEmptyCounter,
  getPerfHourPointsHistogram,
  getProductCountEmptyCounter,
  getProductCountRowsHistogram,
  getRejectReasonEmptyCounter,
  getRejectReasonGroupsHistogram,
  getDowntimeEditsCounter,
  getDowntimeEditConflictsCounter,
  getShiftReportTransitionsCounter,
  getShiftReportTransitionConflictsCounter,
  getOperatorAuthorizationDenialsCounter,
  getOperatorAuthorizationGrantsCounter,
  getTimeZoneResolutionsCounter,
};
