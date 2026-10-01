// Shared column styling for the report list tables.
//
// Percentages get one right-aligned, tabular treatment so the decimal points line
// up down the column. This was previously restated in each list screen with a
// comment saying importing one list screen's internals into another was the
// coupling to avoid — which was right about the coupling and wrong about the fix.
// A module neither of them owns is the fix.
const NUMERIC = { headerClassName: "text-right", cellClassName: "text-right tabular-nums" };

export { NUMERIC };
