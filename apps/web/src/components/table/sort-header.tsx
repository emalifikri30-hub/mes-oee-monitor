import { ChevronDownIcon, ChevronsUpDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

// A sortable column header, shared by every server- or client-sorted table.
//
// Extracted from downtime-details-card.tsx when the Losses page's Pareto table
// became the second caller. It lives here rather than beside either of them
// because `aria-sort` is the part that quietly rots in a copy: the icon tells a
// sighted reader which way the column is ordered, and nothing else does.
//
// Generic over the caller's own sort-by union, so a column name that is not
// sortable fails to compile rather than silently doing nothing.
type SortHeaderProps<TColumn extends string> = {
  label: string;
  column: TColumn;
  sort: { by: TColumn; dir: "asc" | "desc" };
  onSort: (column: TColumn) => void;
};

function SortHeader<TColumn extends string>({
  label,
  column,
  sort,
  onSort,
}: SortHeaderProps<TColumn>) {
  const { t } = useTranslation("oee");
  const active = sort.by === column;

  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className="hover:text-foreground -ml-1 flex items-center gap-1 rounded-sm px-1 py-0.5 transition-colors"
      aria-label={t("common.sortByLabel", { label })}
      // Announces the current order to assistive tech, which the icon alone does not.
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? (
          <ChevronUpIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )
      ) : (
        <ChevronsUpDownIcon className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

export { SortHeader };
export type { SortHeaderProps };
