import { useSelectedArea } from "@/components/layout/area-context";
import { useWorkCenters } from "@/lib/queries";

import type { WorkCenterSummary } from "@/lib/types";

// The Area -> Line cascade, the stranding rule that goes with it, and — since the
// header picker became a REQUEST filter — the area itself.
//
// STILL NAMED FOR THE LINE FILTER, because that is still what most of it does and
// what half its callers want: of the eight, the four OEE Performance screens take
// `options` and `workCenterId` and never look at `areaId`. Only the four report
// LIST tables read the third field.
//
// Extracted because it was written out identically in the two list screens and
// was about to be a third. All three parts are load-bearing and none fails loudly:
//
//   * Switching area can leave a workCenterId in the URL that belongs to the area
//     we just left. It is dropped from the REQUEST but left in the URL, so
//     switching back restores the filter — and core-api is never sent an id it
//     would 404 on.
//   * While the options are still loading, `workCenters` is undefined and
//     `undefined?.every()` is FALSY, so the requested id STANDS. Reversing that
//     would silently widen a filtered list to every machine on the first render,
//     then narrow it a tick later — a flash of the wrong data, on every load.
//   * `areaId` is returned rather than only consumed, because every report list
//     now SENDS it.
//
// WHAT CHANGED, AND THE OLD COMMENT IS WORTH QUOTING BECAUSE IT IS WRONG NOW.
// This file used to end: "The area itself is deliberately not a request filter:
// it only decides which lines a page may OFFER, because core-api's report
// endpoints take a workCenterId and know nothing about areas." Both halves have
// since stopped being true. The requirement is that every report screen — machine,
// line, SKU and area — opens filtered to the selected area, and migration `0028`
// put `area_id` on every report table, so the endpoints do know about areas and
// the filter is a plain column predicate rather than a hierarchy round trip.
//
// THE TWO RETURNED IDS ARE NOT INTERCHANGEABLE AND THE STRANDING RULE IS WHY.
// `workCenterId` is the REQUESTED id after stranding — it can be `undefined` when
// the URL names a line outside the selected area. `areaId` is never stranded: the
// provider falls back to the first area, so it is undefined only while the area
// list is still loading. A caller that gated its query on `areaId !== undefined`
// would show a skeleton on first paint where an unfiltered page is the better
// answer; see the area list screens, which pass it straight through.
function useWorkCenterFilter(requested: number | undefined): {
  options: WorkCenterSummary[];
  workCenterId: number | undefined;
  areaId: number | undefined;
} {
  const { areaId } = useSelectedArea();
  const { data: workCenters } = useWorkCenters(areaId);

  const workCenterId =
    requested !== undefined && workCenters?.every((wc) => wc.id !== requested)
      ? undefined
      : requested;

  return { options: workCenters ?? [], workCenterId, areaId };
}

export { useWorkCenterFilter };
