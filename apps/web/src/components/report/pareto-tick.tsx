// The x-axis tick every Pareto on the Losses page uses.
//
// A plain string tick would render one long line per bar and overlap its
// neighbours, so this wraps at the last space that fits and ellipsises the rest.
//
// EXTRACTED RATHER THAN COPIED because `splitLabel` is an off-by-one-flavoured
// string rule, and a second copy of one of those is the worst kind of duplication:
// both look right, neither has a test, and they drift at the boundary. The reject
// counters the Quality Loss Pareto labels (`Total_NG_Prod`, `NG_Over_Count`) sit
// in the same length class as a downtime reason, so they need exactly this rule
// and not an approximation of it.
//
// Takes `labels` rather than the bars, so it is blind to which family drew the
// chart.

// Long enough to read, short enough that ticks do not collide. A downtime reason
// is free text from a jsonb array and a counter name is a column name, so neither
// has a length bound at all.
const TICK_CHARS = 16;

type TickProps = { x?: number; y?: number; index?: number };

function ParetoTick({ x, y, index, labels }: TickProps & { labels: string[] }) {
  const label = index === undefined ? undefined : labels[index];
  if (label === undefined) return null;

  const [first, second] = splitLabel(label);

  return (
    <text x={x} y={y} textAnchor="middle" fontSize={11} fill="var(--color-muted-foreground)">
      <tspan x={x} dy={14}>
        {first}
      </tspan>
      {second ? (
        <tspan x={x} dy={12}>
          {second}
        </tspan>
      ) : null}
    </text>
  );
}

// Wraps at the last space that fits, so a two-word label breaks between words
// rather than mid-word. Anything still too long is ellipsised.
function splitLabel(label: string): [string, string | undefined] {
  if (label.length <= TICK_CHARS) return [label, undefined];

  const head = label.slice(0, TICK_CHARS);
  const breakAt = head.lastIndexOf(" ");
  const cut = breakAt > 0 ? breakAt : TICK_CHARS;

  const rest = label.slice(cut).trim();
  const tail = rest.length > TICK_CHARS ? `${rest.slice(0, TICK_CHARS - 1)}…` : rest;

  return [label.slice(0, cut).trim(), tail];
}

export { ParetoTick, splitLabel, TICK_CHARS };
