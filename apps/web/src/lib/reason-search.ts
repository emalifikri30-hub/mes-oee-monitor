import type { ReasonSelector } from "@/lib/api";
import type { DowntimeCategory } from "@/lib/types";

// Which downtime-reason bucket a URL names.
//
// Pure, and in lib/ rather than in the route file, following the split
// vite.config.ts states: parsing is far cheaper to cover exhaustively as a
// function than through a rendered route, and this particular parse is the one
// TODOS.md §27 calls a trap.
//
// TWO PARAMS FOR ONE CHOICE. Over the wire the unlabelled bucket is
// `reason IS NULL`; "Unspecified" is a label lib/pareto.ts applies in the
// browser so that a genuine reason of that exact text cannot merge into it. A
// single `?reason=` cannot carry the distinction — `?reason=` and no `reason` at
// all are the same absence to a query string — so a labelled bucket travels as
// `?reason=X` and the null one as `?unlabelled=true`, and exactly one must be
// present.
//
// The Pareto's own row key is NOT usable as a URL: lib/pareto.ts derives it as
// `__unspecified__${index}`, which moves with the ranking, so a link built from
// it would point at a different bucket once the sort toggle changed.
//
//   ?reason=Mlipit          -> { kind: "labelled", reason: "Mlipit" }
//   ?unlabelled=true        -> { kind: "unlabelled" }
//   (neither)               -> {}  ... invalid
//   (both)                  -> {}  ... invalid
//   ?reason=                -> {}  ... invalid, NOT the unlabelled bucket
//
// `category` is WHICH LOSS, which is a different question from which bucket, and
// it does not take part in the XOR above: a category with no bucket is still a
// broken link, and a bucket with no category is an ordinary Availability Loss
// one. See parseLossCategory.
type ReasonSearch = { reason?: string; unlabelled?: true; category?: DowntimeCategory };

// An EMPTY OBJECT is the invalid state, RETURNED rather than thrown.
//
// `notFound()` thrown from a route's `validateSearch` never reaches its
// `notFoundComponent`: TanStack treats anything thrown during search validation
// as a search ERROR and routes it to `errorComponent`. A hand-edited URL then
// reads "something went wrong, try again in a moment", inviting a retry that can
// never succeed. Normalising here and letting the component throw is what
// produces the truthful page.
function parseReasonSearch(search: {
  reason?: unknown;
  unlabelled?: unknown;
  category?: unknown;
}): ReasonSearch {
  const reason =
    typeof search.reason === "string" && search.reason !== "" ? search.reason : undefined;

  // Query params are strings, but a client-side navigation can pass the real
  // boolean, so both spellings are accepted — and nothing else is. `?unlabelled=1`
  // is invalid rather than truthy: silently treating it as the null bucket would
  // answer a different question than the URL asked.
  const unlabelled = search.unlabelled === true || search.unlabelled === "true";

  // Spread rather than assigned, so UNPLANNED contributes NOTHING — see
  // parseLossCategory. This is also what keeps the invalid state below exactly
  // `{}` rather than `{ category: "UNPLANNED" }`.
  const category = parseLossCategory(search.category);

  if (unlabelled && reason === undefined) return { unlabelled: true, ...category };
  if (!unlabelled && reason !== undefined) return { reason, ...category };

  return {};
}

// The three categories a reason breakdown can be about, as the URL spells them.
const CATEGORIES: readonly DowntimeCategory[] = ["PLANNED", "UNPLANNED", "SMALL_STOP"];

// UNPLANNED IS OMITTED, NOT WRITTEN OUT, and that is the whole design of this
// param.
//
// Availability Loss shipped first and its links are already in the wild as
// `?reason=X` with no category at all. Defaulting in the PARSE rather than
// stamping the URL means those links keep resolving, TanStack keeps rendering
// them unchanged rather than rewriting every href, and — the part that matters
// most — `parseReasonSearch`'s documented "an empty object is the invalid state"
// contract survives untouched, along with the suite that pins it.
//
// An unknown value DEGRADES to the default rather than erroring, matching what
// the Losses page's own `tab` param does and for the same reason: a hand-edited
// or stale URL should land somewhere useful. The cost is that `?category=BOGUS`
// silently shows unplanned stops; the alternative is an error page for a
// mistyped query string, on a route whose bucket params already have a
// not-found path for the case that genuinely cannot be served.
function parseLossCategory(value: unknown): { category?: DowntimeCategory } {
  const category = CATEGORIES.find((candidate) => candidate === value);
  return category === undefined || category === DEFAULT_CATEGORY ? {} : { category };
}

// Availability Loss. The API defaults to the same value for the same reason —
// see the note on `reasonBreakdownInputSchema` in downtime-dto.ts.
const DEFAULT_CATEGORY: DowntimeCategory = "UNPLANNED";

// The category a parsed search is about. An absent one IS Availability Loss, so
// this is the only correct way to read `search.category` — a bare
// `search.category` is `DowntimeCategory | undefined` and every caller would
// have to remember the same `?? "UNPLANNED"`.
function toLossCategory(search: ReasonSearch): DowntimeCategory {
  return search.category ?? DEFAULT_CATEGORY;
}

// THE WRITE SIDE of everything above, so the link and the parse are one file and
// one test can round-trip them.
//
// The bucket travels as the RAW reason, never the rendered label: "Unspecified"
// is what lib/pareto.ts calls the null bucket in the browser, and a genuine
// reason of that exact text would collide with it. The Pareto's own row key is
// not usable either — it is `__unspecified__${index}`, which moves with the
// ranking, so a link built from it points at a different bucket the moment the
// sort toggle changes.
//
// The default category is OMITTED, which is what makes the round trip lossless
// while leaving every Availability Loss href exactly as it shipped. See
// parseLossCategory.
type ReasonDetailSearch =
  | { reason: string; category?: DowntimeCategory }
  | { unlabelled: true; category?: DowntimeCategory };

function reasonDetailSearch(
  bar: { reason: string | null },
  category: DowntimeCategory,
): ReasonDetailSearch {
  const bucket = bar.reason === null ? ({ unlabelled: true } as const) : { reason: bar.reason };
  return category === DEFAULT_CATEGORY ? bucket : { ...bucket, category };
}

// The parsed search as the domain's discriminated union, or undefined when the
// URL names no single bucket.
function toReasonSelector(search: ReasonSearch): ReasonSelector | undefined {
  if (search.unlabelled === true) return { kind: "unlabelled" };
  if (search.reason !== undefined) return { kind: "labelled", reason: search.reason };
  return undefined;
}

export {
  DEFAULT_CATEGORY,
  parseReasonSearch,
  reasonDetailSearch,
  toLossCategory,
  toReasonSelector,
};
export type { ReasonDetailSearch, ReasonSearch };
