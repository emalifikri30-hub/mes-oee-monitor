import { formatClockSeconds } from "./format";

import type {
  HourOfDayProfile,
  LinePerformance,
  LinePerfHourBucket,
  PerfHourBucket,
  ShiftPerformance,
} from "./types";

// Turns the hourly performance payload into what the chart draws.
//
// EVERYTHING RISKY LIVES HERE, and the reason is structural: apps/web has no DOM
// test environment (see vite.config.ts and TODOS.md §16), so logic inside a
// component is logic nobody can test. The same move was made for the SKU card in
// lib/product-count.ts and for the waterfall in lib/waterfall.ts.
//
// Three things in here are easy to get wrong and impossible to spot on screen:
//
//   1. A rate is qty over the hours the machine RAN, not over the bucket.
//   2. An average rate is runtime-WEIGHTED. The mean of per-bucket rates is a
//      different, wrong, and flatteringly high number.
//   3. A missing bucket is `null`, not `0`. Zero draws a line to the axis and
//      reads as "we ran and made nothing".
//
//                    ShiftPerformance (flat rows, one per product per hour)
//                                        │
//                     group by productId │ densify against the bucket axis
//                                        ▼
//                    HourlyOutputModel
//                      ├─ buckets[]   the shared x-axis, chronological
//                      ├─ skus[]      one chart block each, 4 series
//                      ├─ qtyDomains  ONE PER UNIT — blocks are comparable only
//                      │               when they share a unit
//                      └─ rateDomain  shared: a rate is per hour whatever the unit

const MS_PER_HOUR = 3_600_000;

type BucketAxis = {
  // ISO instant — the recharts x key and the sort key, never the label.
  key: string;
  // `23:00:00 - 00:00:00`, in the plant's zone.
  label: string;
};

type HourlyPoint = BucketAxis & {
  // Null means this product did not run in this bucket. Recharts skips a null
  // point and draws a gap; a 0 would draw a drop to the axis.
  totalOut: number | null;
  effectiveOut: number | null;
  runtimeMs: number | null;
  // Derived. Null when nothing ran — 0/0 and n/0 are both "no rate observed",
  // never Infinity and never 0.
  actualRatePerHour: number | null;
  idealRatePerHour: number | null;
  // On the row so the tooltip needs no lookup back into the model.
  productName: string;
  uomCode: string;
};

type HourlySkuSeries = {
  productId: number;
  productName: string;
  uomCode: string;
  // Dense and chronological: one point per bucket in `buckets`, same order.
  points: HourlyPoint[];
  // False when no bucket carried a standard. The chart omits the Master Rate line
  // entirely rather than drawing it at zero.
  hasMasterRate: boolean;
  // True when this product has no output at all — every bucket null.
  isEmpty: boolean;
  avgRatePerHour: number | null;
  avgOutPerRunBucket: number | null;
};

type HourlyOutputModel = {
  buckets: BucketAxis[];
  skus: HourlySkuSeries[];
  // Shared across blocks so small multiples are directly comparable. The lower
  // bound is min(0, observed): a negative measure is real data and must stay
  // visible. Contrast lib/waterfall.ts, which clamps deliberately and says so.
  //
  // ONE DOMAIN OVER BOTH totalOut AND effectiveOut, WHICH IS CORRECT FOR A
  // MACHINE AND WOULD BE WRONG FOR A LINE. A machine has a single unit of
  // measure, so "Actual Production" and "Effective Production" are directly
  // comparable and belong on one axis. A LINE HAS TWO: migration 0014 puts
  // total_out in the line's INFEED unit and effective_out in its OUTPUT unit
  // (docs/gold-write-contract.md §16.4a), because a line consumes bags and ships
  // cartons. Plotting those two series against one domain would put bags and
  // cartons on the same scale.
  //
  // STILL NOT FIXED, AND NOW SCOPED PRECISELY. The Line detail screen has shipped
  // and deliberately does NOT include this chart, because a line performance
  // WHAT THAT COMMENT USED TO SAY, kept because the reasoning moved rather than
  // evaporating: this file once recorded that the two-axis fix "cannot be designed
  // yet — its input shape is undecided". It is decided now. Migration 0018 gives
  // the line's hourly rows two uom triples, and contract §19 pins the standard to
  // the output side, so a series knows which unit it is in and the domain follows
  // from that rather than from a guess.
  qtyDomains: Record<string, [number, number]>;
  rateDomain: [number, number];
  // Null when the shift mixed units of measure, and the two shift-wide averages
  // are null with it — BAG and CARTON do not average.
  uomCode: string | null;
  avgRatePerHour: number | null;
  avgOutPerRunBucket: number | null;
};

// A rate is qty over the hours actually RUN, not over the elapsed bucket: a
// 15-minute run that made 10k is 40k/hour, not 10k/hour. That distinction is the
// entire point of a losses drill-down — it is what separates "we were slow" from
// "we were stopped".
//
// Null rather than Infinity or 0 when nothing ran. `runtimeMs <= 0` rather than
// `=== 0` so a negative runtime — which the schema forbids but the wire does not —
// cannot produce a negative rate.
function ratePerHour(qty: number | null, runtimeMs: number | null): number | null {
  if (qty === null || runtimeMs === null || runtimeMs <= 0) return null;
  return qty / (runtimeMs / MS_PER_HOUR);
}

// RUNTIME-WEIGHTED. The mean of per-bucket rates is a different number and it is
// wrong in the flattering direction, because a short sliver at an unrepresentative
// rate carries the same weight as a full hour:
//
//   two full hours at 1000/h, then three minutes at 2000/h
//     mean of rates          = 1333.3 /h   WRONG
//     sum(qty) / sum(hours)  = 1024.4 /h   right
//
// Verified against Postgres 18.4 with the same figures; the equivalent SQL is in
// the COMMENT ON for oee.product_perf_wu_hour.actual_rate_per_hour, so a BI user
// computing this by hand lands on the same value.
function avgRate(points: HourlyPoint[]): number | null {
  let qty = 0;
  let ms = 0;

  for (const point of points) {
    if (point.totalOut === null || point.runtimeMs === null || point.runtimeMs <= 0) continue;
    qty += point.totalOut;
    ms += point.runtimeMs;
  }

  return ms > 0 ? qty / (ms / MS_PER_HOUR) : null;
}

// The denominator is the buckets in which this product RAN, not all of them.
// Counting hours a SKU was never scheduled for would make its average a function
// of the shift's product mix rather than of its own output — and on a shift that
// is still running, of how much of the shift has elapsed.
function avgOutPerRunBucket(points: HourlyPoint[]): number | null {
  const ran = points.filter((point) => point.totalOut !== null);
  if (ran.length === 0) return null;

  const total = ran.reduce((sum, point) => sum + (point.totalOut ?? 0), 0);
  return total / ran.length;
}

// The shared x-axis.
//
// Built by stepping one hour from the first returned bucket to the last, rather
// than from the distinct bucket_start values present. An hour in which the machine
// made nothing produces NO ROW, so taking the axis from the rows would silently
// close the gap and render an idle hour as if it never existed — five points where
// a shift has eight, with the neighbours joined by a straight line that implies
// production nobody made.
//
// Interior gaps only. A missing FIRST or LAST hour cannot be recovered here — that
// needs the shift window, which is deliberately a server-side fact (core-api's
// SHIFT_WINDOWS; the browser has no shift-boundary table). Documented as the
// accepted limit rather than papered over: the watermark, not the axis, is what
// tells the reader the data may be incomplete.
function buildAxis(buckets: PerfHourBucket[], timeZone: string): BucketAxis[] {
  const first = buckets[0];
  const last = buckets.at(-1);
  if (first === undefined || last === undefined) return [];

  const start = new Date(first.bucketStart).getTime();
  const end = new Date(last.bucketStart).getTime();
  // Unparseable instants would make the loop below run forever, so fall back to
  // the rows as they arrived.
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return dedupeAxis(buckets, timeZone);
  }

  const axis: BucketAxis[] = [];
  for (let at = start; at <= end; at += MS_PER_HOUR) {
    const from = new Date(at).toISOString();
    const to = new Date(at + MS_PER_HOUR).toISOString();
    axis.push({
      key: from,
      label: `${formatClockSeconds(from, timeZone)} - ${formatClockSeconds(to, timeZone)}`,
    });
  }

  return axis;
}

// Fallback axis: the distinct bucket instants as they arrived, in order. core-api
// already sorts by bucket_start, so this preserves chronology.
function dedupeAxis(buckets: PerfHourBucket[], timeZone: string): BucketAxis[] {
  const seen = new Set<string>();
  const axis: BucketAxis[] = [];

  for (const bucket of buckets) {
    if (seen.has(bucket.bucketStart)) continue;
    seen.add(bucket.bucketStart);
    axis.push({
      key: bucket.bucketStart,
      label: `${formatClockSeconds(bucket.bucketStart, timeZone)} - ${formatClockSeconds(bucket.bucketEnd, timeZone)}`,
    });
  }

  return axis;
}

// A bucket as the model needs it: the measures, plus whatever string joins it to
// an axis point. Both payload shapes reduce to this.
type ModelRow = Omit<PerfHourBucket, "bucketStart" | "bucketEnd" | "shiftHourSeq"> & {
  // The axis join key. An ISO instant at shift and day grain; a zero-padded clock
  // hour at month grain.
  key: string;
};

// THE TWO GRAIN-DEPENDENT BITS, AND ONLY THEY ARE PARAMETERISED. The axis and the
// join key differ between a chronological chart and an hour-of-day profile;
// nothing else does. The rate math below — a rate is qty over the hours the
// machine RAN, an average rate is runtime-WEIGHTED, a missing bucket is null and
// never 0 — is the part that must not exist twice, and it does not.
// No `timeZone` parameter: every label is already on the axis by the time this
// runs, and the measures carry no zone at all. The two callers do their own
// formatting, which is exactly where the two grains differ.
function buildModel(axis: BucketAxis[], rows: ModelRow[]): HourlyOutputModel {
  // Insertion order is core-api's ORDER BY, so the blocks render in a stable,
  // name-sorted order without the browser re-sorting and risking a different
  // answer.
  const byProduct = new Map<number, ModelRow[]>();
  for (const bucket of rows) {
    const forProduct = byProduct.get(bucket.productId);
    if (forProduct === undefined) byProduct.set(bucket.productId, [bucket]);
    else forProduct.push(bucket);
  }

  const skus: HourlySkuSeries[] = [];
  for (const [productId, rows] of byProduct) {
    const atBucket = new Map(rows.map((row) => [row.key, row]));
    // Every row of one product shares its name and unit; the first is as good as
    // any, and rows is non-empty by construction.
    const head = rows[0] as ModelRow;

    const points: HourlyPoint[] = axis.map(({ key, label }) => {
      const row = atBucket.get(key);
      if (row === undefined) {
        // Did not run this hour. Every measure null so the lines gap rather than
        // dropping to zero.
        return {
          key,
          label,
          totalOut: null,
          effectiveOut: null,
          runtimeMs: null,
          actualRatePerHour: null,
          idealRatePerHour: null,
          productName: head.productName,
          uomCode: head.uomCode,
        };
      }

      return {
        key,
        label,
        totalOut: row.totalOut,
        effectiveOut: row.effectiveOut,
        runtimeMs: row.runtime,
        actualRatePerHour: ratePerHour(row.totalOut, row.runtime),
        idealRatePerHour: row.idealRatePerHour,
        productName: row.productName,
        uomCode: row.uomCode,
      };
    });

    skus.push({
      productId,
      productName: head.productName,
      uomCode: head.uomCode,
      points,
      hasMasterRate: points.some((point) => point.idealRatePerHour !== null),
      isEmpty: points.every((point) => point.totalOut === null),
      avgRatePerHour: avgRate(points),
      avgOutPerRunBucket: avgOutPerRunBucket(points),
    });
  }

  const allPoints = skus.flatMap((sku) => sku.points);
  const units = new Set(skus.map((sku) => sku.uomCode));
  // One unit or none. Averaging BAG with CARTON is meaningless, so a mixed shift
  // reports no shift-wide figure rather than a plausible wrong one — the same rule
  // that makes a line-level SKU roll-up an open question in TODOS.md §15.
  const uomCode = units.size === 1 ? (skus[0]?.uomCode ?? null) : null;

  return {
    buckets: axis,
    skus,
    qtyDomains: qtyDomainsOf(skus),
    rateDomain: domainOf(allPoints.flatMap((p) => [p.actualRatePerHour, p.idealRatePerHour])),
    uomCode,
    avgRatePerHour: uomCode === null ? null : avgRate(allPoints),
    avgOutPerRunBucket: uomCode === null ? null : avgOutPerRunBucket(allPoints),
  };
}

// THE LINE'S hourly chart, at shift and day grain.
//
// ---------------------------------------------------------------------------
// IT PLOTS THE OUTPUT SIDE, AND LEAVES THE INFEED OUT. That is the two-unit
// answer, and it is a smaller change than the two axes this file's comments used
// to anticipate.
// ---------------------------------------------------------------------------
//
// A line has two count points in two units (0014, contract §16.4a), so the
// tempting shape — `totalOut` and `effectiveOut` on one chart — draws bags
// against cartons and looks entirely plausible. Two Y axes or two blocks would
// both work and both cost more than the alternative:
//
//   `goodOut` and `effectiveOut` ARE BOTH OUTPUT-SIDE. They share a unit, they
//   share a scale, and they are what the tab is about — performance is
//   effective_out / ideal_out, and the standard is output-denominated too
//   (contract §19.2). So the chart draws those two plus the two rates, all in one
//   unit, on the axes the machine chart already has.
//
// `total_out` is INFEED CONTEXT, and both migration 0018 and §19 say so in as
// many words: "a CONTEXT series on the chart, never a numerator". It is carried
// in the payload for the tooltip and simply not drawn.
//
// The mapping into ModelRow is therefore a RENAME, not arithmetic: `goodOut`
// takes the slot the machine chart fills with `totalOut`, so the legend's "Actual
// Production" means what came off the end of the line. `actualRatePerHour` falls
// out of that slot too, which is correct — it is then output over runtime,
// commensurable with the output-side standard it is drawn against.
function buildLineHourlyOutput({ buckets, timeZone }: LinePerformance): HourlyOutputModel {
  return buildModel(buildAxis(toPerfBuckets(buckets), timeZone), toModelRows(buckets));
}

// The LINE's month profile: 24 hour-of-DAY buckets, ~720 hourly rows collapsed by
// the server. Same output-side mapping as above — see its header — over the other
// axis.
//
// TWO CALLERS, and it shipped with one. The Losses page's Trendline sub-tab has
// always served all three grains; the Losses CARD's View button did not, and this
// header said the card "deliberately does not offer it: a month is not a
// chronological chart". The first half of that is true and is why this function
// exists at all — a month is not a chronological chart, so it gets a different
// one. The second half was a rationalisation of a missing read: the dialog simply
// did not call `useLineHourProfile`, so the button would have opened an empty
// panel. Both surfaces reach this now, at every grain, on both subjects.
function buildLineHourOfDayOutput(payload: LinePerformance): HourlyOutputModel {
  return buildHourOfDayOutput({
    timeZone: payload.timeZone,
    dayStartHour: payload.dayStartHour,
    loadedThrough: payload.loadedThrough,
    buckets: payload.buckets.map((bucket) => ({
      hourOfDay: bucket.hourOfDay,
      productId: bucket.productId,
      productName: bucket.productName,
      productCode: bucket.productCode,
      // OUTPUT unit, and the goodOut rename — identical to toPerfBuckets, for the
      // reason its header gives.
      uomCode: bucket.outputUomCode ?? bucket.infeedUomCode ?? "",
      totalOut: bucket.goodOut ?? 0,
      effectiveOut: bucket.effectiveOut ?? 0,
      runtime: bucket.runtime,
      idealRatePerHour: bucket.idealRatePerHour,
      timeZone: payload.timeZone,
    })),
  });
}

// A line bucket in the machine bucket's shape. The unit is the OUTPUT one,
// because that is what the plotted measures are denominated in; when the line
// abstained on it (0014: NULL means "the members disagreed") the block falls back
// to the infeed code rather than to an empty label, so the axis still names
// something a reader can check rather than reading as unitless.
function toPerfBuckets(buckets: LinePerfHourBucket[]): PerfHourBucket[] {
  return buckets.map((bucket) => ({
    bucketStart: bucket.bucketStart,
    bucketEnd: bucket.bucketEnd,
    hourOfDay: bucket.hourOfDay,
    shiftHourSeq: bucket.shiftHourSeq,
    productId: bucket.productId,
    productName: bucket.productName,
    productCode: bucket.productCode,
    uomCode: bucket.outputUomCode ?? bucket.infeedUomCode ?? "",
    // THE RENAME. See the header: goodOut is what came off the end, and it takes
    // the slot the machine chart fills with its single-count-point totalOut.
    totalOut: bucket.goodOut ?? 0,
    effectiveOut: bucket.effectiveOut ?? 0,
    runtime: bucket.runtime,
    idealRatePerHour: bucket.idealRatePerHour,
  }));
}

function toModelRows(buckets: LinePerfHourBucket[]) {
  return toPerfBuckets(buckets).map((bucket) => ({ ...bucket, key: bucket.bucketStart }));
}

// The chronological chart: shift grain (8 buckets) and day grain (24).
function buildHourlyOutput({ buckets, timeZone }: ShiftPerformance): HourlyOutputModel {
  return buildModel(
    buildAxis(buckets, timeZone),
    buckets.map((bucket) => ({ ...bucket, key: bucket.bucketStart })),
  );
}

// The MONTH chart: an hour-of-day profile.
//
// THE AXIS IS ALWAYS 24 POINTS, whatever came back, and that is deliberate. An
// axis built from the rows present would silently hide the hours a machine never
// ran — which on a performance profile is the most interesting thing on the
// chart. Absent hours render as gaps, because every measure is null for them.
//
// ROTATED TO BUSINESS-DAY ORDER using the server's `dayStartHour`. An axis running
// 00..23 splits the night shift across both ends of the chart, and the browser has
// no shift table of its own to rotate with — which is why that number is on the
// payload.
//
// `timeZone` IS ON THE PAYLOAD AND DELIBERATELY UNUSED HERE. `hourOfDay` is
// already a plant-local clock hour the pipeline computed, so formatting it
// through a zone would rotate every label by the plant's offset. The zone rides
// along because the card's header still reports it.
function buildHourOfDayOutput({ buckets, dayStartHour }: HourOfDayProfile): HourlyOutputModel {
  const axis: BucketAxis[] = Array.from({ length: 24 }, (_, offset) => {
    const hour = (dayStartHour + offset) % 24;
    return {
      key: hourKey(hour),
      // No zone conversion: `hourOfDay` is ALREADY a plant-local clock hour the
      // pipeline computed. Formatting it through a zone would rotate every label.
      label: `${pad2(hour)}:00 - ${pad2((hour + 1) % 24)}:00`,
    };
  });

  return buildModel(
    axis,
    buckets.map((bucket) => ({ ...bucket, key: hourKey(bucket.hourOfDay) })),
  );
}

function hourKey(hour: number): string {
  return pad2(hour);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Always includes zero, so the baseline is meaningful and blocks share it. The
// lower bound is min(0, observed) rather than 0: reduce-speed loss goes negative
// when a machine outruns its standard, and effective output can follow it, and
// that is real data shown as-is — the same rule the Losses card states.
// One domain per unit, over every series denominated in it.
//
// Both of a block's quantity series go into ITS OWN unit's bucket. At machine
// grain that is the same unit for both, so this reduces to the old behaviour for
// a single-unit shift — which is the common case and must not change.
function qtyDomainsOf(
  skus: { uomCode: string; points: HourlyPoint[] }[],
): Record<string, [number, number]> {
  const byUnit = new Map<string, (number | null)[]>();

  for (const sku of skus) {
    const values = byUnit.get(sku.uomCode) ?? [];
    for (const point of sku.points) values.push(point.totalOut, point.effectiveOut);
    byUnit.set(sku.uomCode, values);
  }

  return Object.fromEntries([...byUnit].map(([unit, values]) => [unit, domainOf(values)]));
}

// The domain for one series' unit, or the WIDEST when the unit is unknown.
//
// The fallback is the safe direction rather than a convenience: a series drawn
// slightly small is readable, one drawn off the top of its block is not. An empty
// model has no domains at all, which `domainOf` already answers as [0, 0].
function qtyDomainFor(model: HourlyOutputModel, uomCode: string | null): [number, number] {
  const own = uomCode === null ? undefined : model.qtyDomains[uomCode];
  if (own !== undefined) return own;

  const all = Object.values(model.qtyDomains);
  if (all.length === 0) return [0, 0];
  return [Math.min(...all.map(([lo]) => lo)), Math.max(...all.map(([, hi]) => hi))];
}

function domainOf(values: (number | null)[]): [number, number] {
  const present = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (present.length === 0) return [0, 0];

  return [Math.min(0, ...present), Math.max(0, ...present)];
}

export {
  buildLineHourlyOutput,
  buildLineHourOfDayOutput,
  qtyDomainFor,
  buildHourlyOutput,
  buildHourOfDayOutput,
  ratePerHour,
};
export type { BucketAxis, HourlyOutputModel, HourlyPoint, HourlySkuSeries };
