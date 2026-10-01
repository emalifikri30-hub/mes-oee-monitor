import { describe, expect, it } from "vite-plus/test";

import {
  parseReasonSearch,
  reasonDetailSearch,
  toLossCategory,
  toReasonSelector,
} from "@/lib/reason-search";

import type { DowntimeCategory } from "@/lib/types";

// The trap TODOS.md §27 names, covered exhaustively as a function.
//
// Every wrong answer here is silent: the page renders a plausible table of the
// wrong reason's stops, or an empty one, and nothing on screen says which.
describe("parseReasonSearch", () => {
  it("reads a labelled bucket", () => {
    expect(parseReasonSearch({ reason: "Mlipit" })).toEqual({ reason: "Mlipit" });
  });

  it("reads the unlabelled bucket from the string form a query param arrives as", () => {
    expect(parseReasonSearch({ unlabelled: "true" })).toEqual({ unlabelled: true });
  });

  it("reads the unlabelled bucket from the boolean a client-side navigation passes", () => {
    expect(parseReasonSearch({ unlabelled: true })).toEqual({ unlabelled: true });
  });

  // An empty reason is NOT the unlabelled bucket. `?reason=` and no `reason` are
  // the same absence to a query string, which is the whole reason `unlabelled`
  // exists as a separate param.
  it.each([
    ["neither param", {}],
    ["both params", { reason: "Mlipit", unlabelled: "true" }],
    ["an empty reason", { reason: "" }],
    ["unlabelled=false alone", { unlabelled: "false" }],
    ["a truthy-looking unlabelled", { unlabelled: "1" }],
    ["a non-string reason", { reason: 7 }],
  ])("rejects %s as invalid rather than guessing", (_label, input) => {
    expect(parseReasonSearch(input)).toEqual({});
  });

  // A real reason literally named "Unspecified" must stay its own bucket. The
  // label the browser shows for null is the same word, and merging the two would
  // attribute one machine's stops to another cause.
  it("keeps a reason named Unspecified as a labelled bucket", () => {
    expect(parseReasonSearch({ reason: "Unspecified" })).toEqual({ reason: "Unspecified" });
    expect(toReasonSelector({ reason: "Unspecified" })).toEqual({
      kind: "labelled",
      reason: "Unspecified",
    });
  });
});

describe("toReasonSelector", () => {
  it("maps each valid shape to the domain union", () => {
    expect(toReasonSelector({ reason: "Mlipit" })).toEqual({ kind: "labelled", reason: "Mlipit" });
    expect(toReasonSelector({ unlabelled: true })).toEqual({ kind: "unlabelled" });
  });

  // The signal the route turns into notFound(). Undefined rather than a default
  // bucket: guessing one would show the operator a different reason's stops under
  // the heading they clicked.
  it("returns undefined for the invalid shape", () => {
    expect(toReasonSelector({})).toBeUndefined();
  });
});

// WHICH LOSS, which is a separate question from which bucket — so these check
// that the two do not interfere. The Availability Loss links already in the wild
// carry no category at all, and the whole point of omitting the default is that
// every assertion in the two suites above keeps passing UNEDITED.
describe("the loss category on a reason URL", () => {
  it("reads a non-default category alongside a labelled bucket", () => {
    expect(parseReasonSearch({ reason: "Cleaning", category: "PLANNED" })).toEqual({
      reason: "Cleaning",
      category: "PLANNED",
    });
  });

  it("reads a non-default category alongside the unlabelled bucket", () => {
    expect(parseReasonSearch({ unlabelled: "true", category: "PLANNED" })).toEqual({
      unlabelled: true,
      category: "PLANNED",
    });
  });

  // The reason the default is omitted rather than stamped: an availability link
  // stays byte-identical, so nothing already shared has to be rewritten.
  it("omits UNPLANNED rather than writing it into the URL", () => {
    expect(parseReasonSearch({ reason: "Mlipit", category: "UNPLANNED" })).toEqual({
      reason: "Mlipit",
    });
  });

  // Degrades rather than erroring, like the Losses page's `tab` param. An error
  // page for a mistyped query string helps nobody.
  it.each([
    ["an unknown category", "PLANNED_MAINTENANCE"],
    ["a lowercased category", "planned"],
    ["a non-string category", 7],
    ["an empty category", ""],
  ])("drops %s and falls back to unplanned", (_label, category) => {
    const parsed = parseReasonSearch({ reason: "Mlipit", category });
    expect(parsed).toEqual({ reason: "Mlipit" });
    expect(toLossCategory(parsed)).toBe("UNPLANNED");
  });

  // Category does NOT take part in the selector XOR. A URL naming a loss but no
  // bucket is still the broken link the route turns into notFound().
  it("does not make a bucketless URL valid", () => {
    expect(parseReasonSearch({ category: "PLANNED" })).toEqual({});
    expect(toReasonSelector(parseReasonSearch({ category: "PLANNED" }))).toBeUndefined();
  });

  it("reads an absent category as availability loss", () => {
    expect(toLossCategory({ reason: "Mlipit" })).toBe("UNPLANNED");
    expect(toLossCategory({ reason: "Cleaning", category: "PLANNED" })).toBe("PLANNED");
    expect(toLossCategory({ unlabelled: true, category: "SMALL_STOP" })).toBe("SMALL_STOP");
  });
});

// THE ROUND TRIP, which is the assumption the whole URL design rests on: a link
// this app writes must parse back to the same bucket and the same loss. Omitting
// the default category is only safe if reading it back is lossless, and that is
// what these check — the write and the parse live in one file precisely so this
// test can exist.
describe("reasonDetailSearch", () => {
  const BUCKETS = [
    ["a labelled bucket", { reason: "Ganti Film" }],
    ["the unlabelled bucket", { reason: null }],
    // A genuine reason that collides with the browser's label for the null
    // bucket. It must stay labelled through a full round trip.
    ["a reason named Unspecified", { reason: "Unspecified" }],
  ] as const;

  const CATEGORIES: DowntimeCategory[] = ["UNPLANNED", "PLANNED", "SMALL_STOP"];

  for (const [label, bar] of BUCKETS) {
    it.each(CATEGORIES)(`round-trips ${label} under %s`, (category) => {
      const parsed = parseReasonSearch(reasonDetailSearch(bar, category));

      expect(toReasonSelector(parsed)).toEqual(
        bar.reason === null ? { kind: "unlabelled" } : { kind: "labelled", reason: bar.reason },
      );
      expect(toLossCategory(parsed)).toBe(category);
    });
  }

  // The back-compat pin. An availability link must come out exactly as it shipped,
  // so nothing already shared has to be rewritten and the shipped tab's own tests
  // keep asserting the same hrefs.
  it("writes no category at all for availability loss", () => {
    expect(reasonDetailSearch({ reason: "Mlipit" }, "UNPLANNED")).toEqual({ reason: "Mlipit" });
    expect(reasonDetailSearch({ reason: null }, "UNPLANNED")).toEqual({ unlabelled: true });
  });

  it("names a non-default category explicitly", () => {
    expect(reasonDetailSearch({ reason: "Cleaning" }, "PLANNED")).toEqual({
      reason: "Cleaning",
      category: "PLANNED",
    });
    expect(reasonDetailSearch({ reason: null }, "PLANNED")).toEqual({
      unlabelled: true,
      category: "PLANNED",
    });
  });
});
