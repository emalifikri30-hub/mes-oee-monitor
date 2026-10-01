// THE WAYS AN OEE PERFORMANCE SCREEN LEGITIMATELY HAS NOTHING TO DRAW.
//
// Each sentence says something DIFFERENT, and they were one skeleton once — which
// is the worst of the options available: a screen that is permanently loading looks
// like a bug in the app rather than a fact about the plant, and nobody can act on
// it.
//
// PURE, AND HERE RATHER THAN IN THE SIX ROUTES, for the reason selection.ts states:
// the rule below that actually fails is a NEGATIVE rendered too early, and six
// hand-copied ladders is six chances to get the guard wrong in a way that reads as
// correct. The route files keep the JSX; this owns the decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LADDERS DIFFER BY SUBJECT, NOT BY GRAIN — which is why this is three
// functions with a NOUN parameter rather than a six-cell table.
// ─────────────────────────────────────────────────────────────────────────────
//
//   machine   three rungs   area has no lines -> line has no machines -> no report
//   line      two rungs     area has no lines ->                         no report
//   area      two rungs     no areas          ->                         no report
//
// A machine screen has the deepest cascade because it resolves two levels below the
// header's area picker; an area screen resolves none.
//
// ─────────────────────────────────────────────────────────────────────────────
// `settled` IS THE LOAD-BEARING ARGUMENT AND IT GUARDS THE LAST RUNG ONLY
// ─────────────────────────────────────────────────────────────────────────────
//
// "This machine has no report for the selected month" is a CONFIDENT NEGATIVE. It
// is true only once the list has genuinely answered — and every list on this
// surface serves the PREVIOUS subject's rows as placeholder data while the next
// loads, so a ladder reading `!isPending` states that negative about a machine
// whose rows have not arrived. See isListSettled, which is the four-token function
// that fact is worth.
//
// The earlier rungs need no such guard: "this line has no machines" is derived from
// a master-data CATALOGUE, which is stable across periods and is either loaded or
// undefined.
//
// A MACHINE WITH NO REPORT IS REACHABLE AT ALL only because the pickers are
// master-data catalogues rather than projections of the report list. Sourced from
// the rows, such a machine would simply be absent from its own dropdown and the
// screen could never say this — which is the state an operator most needs named.

// "month" on the three monthly screens, "year" on the three yearly ones. The only
// thing the grain axis changes in this file.
type PeriodNoun = "month" | "year";

type MachineEmptyInput = {
  lineCount: number;
  workCenterId: number | undefined;
  // `undefined` while the catalogue is loading — NOT an empty array. The two mean
  // opposite things and only one of them is a sentence.
  machineOptions: readonly unknown[] | undefined;
  settled: boolean;
  workUnitId: number | undefined;
  hasReport: boolean;
  periodNoun: PeriodNoun;
};

function machineEmptyState({
  lineCount,
  workCenterId,
  machineOptions,
  settled,
  workUnitId,
  hasReport,
  periodNoun,
}: MachineEmptyInput): string | undefined {
  if (lineCount === 0 && workCenterId === undefined) return "This area has no lines.";
  if (machineOptions !== undefined && machineOptions.length === 0) {
    return "This line has no machines.";
  }
  if (settled && workUnitId !== undefined && !hasReport) {
    return `This machine has no report for the selected ${periodNoun}.`;
  }

  return undefined;
}

type LineEmptyInput = {
  lineCount: number;
  workCenterId: number | undefined;
  settled: boolean;
  hasReport: boolean;
  periodNoun: PeriodNoun;
};

function lineEmptyState({
  lineCount,
  workCenterId,
  settled,
  hasReport,
  periodNoun,
}: LineEmptyInput): string | undefined {
  if (lineCount === 0 && workCenterId === undefined) return "This area has no lines.";
  if (settled && workCenterId !== undefined && !hasReport) {
    return `This line has no report for the selected ${periodNoun}.`;
  }

  return undefined;
}

type AreaEmptyInput = {
  areaId: number | undefined;
  // Whether the header's area catalogue has answered. An area screen has no picker
  // of its own, so "no areas at all" is the only structural empty it can reach.
  areasLoaded: boolean;
  settled: boolean;
  hasReport: boolean;
  periodNoun: PeriodNoun;
};

function areaEmptyState({
  areaId,
  areasLoaded,
  settled,
  hasReport,
  periodNoun,
}: AreaEmptyInput): string | undefined {
  if (areasLoaded && areaId === undefined) return "There are no areas.";
  if (settled && areaId !== undefined && !hasReport) {
    return `This area has no report for the selected ${periodNoun}.`;
  }

  return undefined;
}

export { areaEmptyState, lineEmptyState, machineEmptyState };
export type { PeriodNoun };
