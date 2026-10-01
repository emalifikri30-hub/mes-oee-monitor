import * as z from "zod";

// The query-parameter validators shared by every report LIST endpoint.
//
// LIFTED OUT OF work-unit-dto.ts once a second module needed them, which is the
// rule shared/shift-window.ts and shared/actor.ts already follow. Modules never
// import each other's internals; a module importing from shared/ is how two
// slices legitimately agree on something.
//
// It is worth being specific about WHAT would drift, because two of these are
// traps rather than preferences and a hand-copied second version loses exactly
// the part that matters.
//
// Query params arrive as strings, so everything numeric is coerced.

const monthFilter = z.optional(z.coerce.number().check(z.int(), z.gte(1), z.lte(12)));

const yearFilter = z.optional(z.coerce.number().check(z.int(), z.gte(1970), z.lte(9999)));

// `shift` is a smallint column, so it has to reach the repository as a number:
// binding a string would make Postgres parse it, and `?shift=abc` would come back
// as `invalid input syntax for type smallint` — a 500 for what is plainly a bad
// request.
//
// THE EMPTY-STRING ARM IS LOAD-BEARING AND MUST STAY AHEAD OF THE NUMERIC CHECK.
// `?shift=` means "all shifts" — the list screens clear a filter by dropping the
// value, but a bookmarked or hand-edited URL keeps the key — and `Number("")` is
// 0, so coercing first would answer that URL with a 400.
//
// Nested rather than a three-stage pipe: z.pipe takes exactly two schemas.
const shiftFilter = z.pipe(
  z.pipe(
    z.optional(z.string()),
    z.transform((v) => (v === undefined || v === "" ? undefined : Number(v))),
  ),
  z.optional(z.number().check(z.int(), z.gte(1), z.lte(3))),
);

const workCenterIdFilter = z.optional(z.coerce.number().check(z.int(), z.positive()));

// THE AREA FILTER — now on EVERY report list, which is a reversal worth stating
// because several comments in this repo still predate it.
//
// It used to mean one thing on two endpoints. The header's area picker, per
// apps/web's hooks/use-work-center-filter.ts, "never filters a request on its
// own" — it only decided which LINES a page could offer — and the area reports
// were the sole exception because there the area is the SUBJECT rather than a
// lens. That is no longer the shape. The requirement is that every report screen
// — machine, line, SKU and area — opens filtered to the area selected in the
// header, so this validator is on all four modules' list schemas and the browser
// sends it unconditionally.
//
// TWO DIFFERENT MEANINGS SURVIVE THAT, AND CONFLATING THEM IS THE TRAP:
//
//   area report lists   the area IS the row. `?areaId=` picks WHICH REPORT.
//   every other list    the area is a LENS over rows keyed by something else.
//                       `?areaId=` narrows a machine / line / SKU page.
//
// The coercion is identical, which is why they share a validator; what they are
// not allowed to share is a repository predicate, because one filters the grain
// key and the other filters a denormalised label that `0028` added and the
// pipeline may not have resolved. A NULL `area_id` is EXCLUDED from the second
// kind, silently, and TODOS §78 is why that is accepted rather than counted.
//
// HERE RATHER THAN IN area-report-dto.ts for the reason `productIdFilter` gives
// one subject over, and it now has eleven callers rather than two: two copies of
// a coercion this small would not fail loudly, they would disagree about whether
// `?areaId=` means "every area" or "area NaN".
//
// THE EMPTY-STRING ARM IS `shiftFilter`'S TRAP, AND THIS FILTER IS THE ONE MOST
// EXPOSED TO IT. `?areaId=` must mean "every area", not 400: `Number("")` is 0,
// which fails `.positive()`, so a plain `z.coerce` rejects it. That used to be a
// theoretical URL — nothing sent an empty area — and it is not one any more, now
// that every report screen carries the parameter and every report URL is
// bookmarkable with it cleared. The arm has to sit AHEAD of the numeric check for
// the same reason it does there.
//
// `workCenterIdFilter` and `productIdFilter` above still have the plain shape and
// therefore still 400 on an empty value. That is pre-existing and is NOT widened
// here on the way past — see TODOS §84.
const areaIdFilter = z.pipe(
  z.pipe(
    z.optional(z.string()),
    z.transform((v) => (v === undefined || v === "" ? undefined : Number(v))),
  ),
  z.optional(z.number().check(z.int(), z.positive())),
);

// Only the literal "true" hides zero-OEE rows; anything else — including an absent
// param — means "show everything", matching each repository's `isHideZero === true`
// check.
const hideZeroFilter = z.pipe(
  z.optional(z.string()),
  z.transform((v) => v === "true"),
);

// THE SKU FILTER. Same shape as workCenterIdFilter, and here rather than in the
// product module because it has two callers on two different axes: the SKU report
// LIST narrows by product, and the downtime reads narrow by product alongside a
// scope (migration 0020 — product is a FILTER applied beside a scope, never a
// fifth member of SCOPE_COLUMN).
//
// Two copies of a coercion this small would not fail loudly; they would disagree
// about whether `?productId=` means "all products" or "product NaN", which is the
// trap shiftFilter's empty-string arm exists for one field over.
const productIdFilter = z.optional(z.coerce.number().check(z.int(), z.positive()));

export {
  areaIdFilter,
  hideZeroFilter,
  monthFilter,
  productIdFilter,
  shiftFilter,
  workCenterIdFilter,
  yearFilter,
};
