import type { ColumnDef } from "@tanstack/react-table";

// The "#" column, shared by every paged table on the report screens.
//
// Extracted because it was written out identically in two column builders and
// was about to be a third. The rule it encodes is the reason it is worth
// sharing rather than retyping: the number is CONTINUOUS ACROSS PAGES — row 1 of
// page 2 at size 5 is "6", not "1" — which only works if the caller has put
// `{ page, size }` on the table's `meta`. A table that forgets is off by a page,
// silently, and looks entirely plausible.
//
// Generic over the row type, so it composes with each caller's own columns
// without widening them to `unknown`.
function indexColumn<TRow>(): ColumnDef<TRow, unknown> {
  return {
    id: "index",
    header: "#",
    meta: { headerClassName: "w-10", cellClassName: "tabular-nums text-muted-foreground" },
    cell: ({ row, table }) => {
      const { page = 1, size = 0 } = table.options.meta ?? {};
      return (page - 1) * size + row.index + 1;
    },
  };
}

export { indexColumn };
