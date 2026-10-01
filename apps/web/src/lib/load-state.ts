import { isLoadedThrough } from "@/lib/watermark";

// Which of the six states a watermarked, gated card should render.
//
// Extracted from lib/pareto.ts, where it was `selectParetoState`, when the
// Availability Loss detail page needed the identical ladder. Generalised rather
// than copied because the ORDER is the part that is wrong when this is wrong,
// and a second copy is a second chance to get the order wrong somewhere no test
// is looking.
//
// `no-params` MUST BE FIRST. When the report's date cannot be reduced to a
// business day — or, on the detail page, when no reason has been selected —
// there is nothing to request, so the query is gated off with `enabled: false`.
// A gated useQuery reports `status: "pending"` FOREVER. Any ladder reading
// isPending first renders a skeleton that never resolves, which is precisely the
// bug that shipped in two cards on this page and was fixed in 2b33e1d.
//
//   hasParams? ──no──▶ no-params        nothing to ask for
//        │yes
//   isError?   ──yes─▶ error
//        │no
//   pending?   ──yes─▶ pending          a real request is in flight
//        │no
//   isEmpty?   ──no──▶ ready
//        │yes
//   loaded?    ──yes─▶ empty-loaded     genuinely nothing to show
//        └────no────▶ empty-stale       the pipeline has not reached this day
//
// The last split is the one that matters and the flattering reading is the wrong
// one: an empty result the pipeline cannot vouch for must not render as a clean
// shift. TODOS.md §8.
type LoadState = "no-params" | "pending" | "error" | "empty-loaded" | "empty-stale" | "ready";

// The two fields the stale/loaded split needs. Every watermarked payload on this
// screen carries them, so callers pass their own response type through.
type Watermarked = {
  timeZone: string;
  loadedThrough: string | null;
};

type LoadStateInput<T extends Watermarked> = {
  hasParams: boolean;
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
  reportDate: string | null | undefined;
  // What "nothing to show" means for this payload — no buckets, no rows, no
  // entries. A predicate rather than a field, because each surface answers it
  // from a different part of its own response.
  isEmpty: (data: T) => boolean;
};

function selectLoadState<T extends Watermarked>({
  hasParams,
  isPending,
  isError,
  data,
  reportDate,
  isEmpty,
}: LoadStateInput<T>): LoadState {
  if (!hasParams) return "no-params";
  if (isError) return "error";
  if (isPending || data === undefined) return "pending";
  if (!isEmpty(data)) return "ready";

  return isLoadedThrough(reportDate, data.timeZone, data.loadedThrough)
    ? "empty-loaded"
    : "empty-stale";
}

export { selectLoadState };
export type { LoadState, Watermarked };
