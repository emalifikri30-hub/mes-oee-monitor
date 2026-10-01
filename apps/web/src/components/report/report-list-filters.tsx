import { useTranslation } from "react-i18next";

import { SHIFTS } from "@/lib/shift-search";
import { reportYearOptions } from "@/lib/year-options";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { WorkCenterSummary } from "@/lib/types";

// The filter controls shared by every report list screen.
//
// Extracted on the third caller, per the rule shared/shift-window.ts states in
// core-api and components/table/index-column.tsx states here. Each of these owns
// exactly one rule that was previously duplicated, and each of those rules fails
// SILENTLY when a copy drifts — a dropdown that disagrees with the table it
// controls, or a filter that quietly stops applying.
//
// They are deliberately dumb: value in, change out. No query, no context, no URL.

const MONTH_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;

// The sentinel the Selects use for "no filter". It never reaches the network:
// every onChange below maps it back to `undefined`, which lib/api.ts strips, and
// core-api reads an absent param as "no predicate". A sentinel that DID reach the
// wire would have to be translated back to absence on both sides.
const ALL = "all";

function MonthFilter({ value, onChange }: { value: number; onChange: (month: number) => void }) {
  const { t } = useTranslation("oee");

  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-36" aria-label={t("common.month")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MONTH_KEYS.map((key) => (
          <SelectItem key={key} value={key}>
            {t(`common.months.${key}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Owns the rolling window AND the "keep a shared link's out-of-window year
// selectable" rule, via lib/year-options.ts where it is tested as a function.
function YearFilter({ value, onChange }: { value: number; onChange: (year: number) => void }) {
  const { t } = useTranslation("oee");
  const years = reportYearOptions(value);

  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-28" aria-label={t("common.year")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {years.map((year) => (
          <SelectItem key={year} value={String(year)}>
            {year}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Reads SHIFTS from lib/shift-search.ts — the SAME array the URL validator uses,
// so the picker cannot offer a value the validator would drop.
function ShiftFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (shift: string | undefined) => void;
}) {
  const { t } = useTranslation("oee");

  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="w-36" aria-label={t("table.shift")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("table.allShifts")}</SelectItem>
        {SHIFTS.map((shift) => (
          <SelectItem key={shift} value={shift}>
            {shift}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// One numeric picker over a list of named things, with an "all" sentinel.
//
// EXTRACTED ON THE SECOND CALLER, when the OEE Performance dashboard needed a
// MACHINE picker that was LineFilter with a different word in three places. The
// two rules here are the ones that fail silently when a copy drifts: the sentinel
// must never reach the wire (see ALL above), and the trigger must carry an
// `aria-label`, which is the only thing the tests and a screen reader can tell two
// adjacent dropdowns apart by.
//
// DELIBERATELY NOT GENERIC OVER THE OPTION TYPE beyond `{ id, name }`. Every
// catalogue in this app is a summary of that shape, and widening it to a render
// prop would let a caller put something other than a name in a picker.
//
// `allLabel` IS OPTIONAL, AND ITS ABSENCE IS A DIFFERENT CONTROL. A report LIST
// can meaningfully show every line at once, so it passes one. The OEE Performance
// dashboard cannot: it is about ONE machine, and there is no report to draw for
// "all" of them. Rendering an "All Machines" item there offers a selection that
// resolves to nothing and then reads as a loading screen — which is exactly how it
// shipped first and what the placeholder replaces.
function SummaryFilter({
  label,
  allLabel,
  placeholder,
  options,
  value,
  onChange,
  className = "w-44",
}: {
  label: string;
  // Omit for a picker with no "all" state. `placeholder` is then what an unset
  // value reads as.
  allLabel?: string;
  placeholder?: string;
  options: readonly { id: number; name: string }[];
  value: number | undefined;
  onChange: (id: number | undefined) => void;
  className?: string;
}) {
  return (
    <Select
      // A Radix Select cannot hold `undefined` as a value, so an unset picker with
      // no ALL item gets an empty string — which renders the placeholder.
      value={value === undefined ? (allLabel === undefined ? "" : ALL) : String(value)}
      onValueChange={(v) => onChange(v === ALL ? undefined : Number(v))}
    >
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allLabel !== undefined && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.id} value={String(option.id)}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Options come from the area chosen in the header — core-api will only list work
// centers within one area. The caller passes them in (see useWorkCenterFilter),
// so this control never fetches.
function LineFilter({
  options,
  value,
  onChange,
}: {
  options: WorkCenterSummary[];
  value: number | undefined;
  onChange: (workCenterId: number | undefined) => void;
}) {
  const { t } = useTranslation("oee");

  return (
    <SummaryFilter
      label={t("table.line")}
      allLabel={t("table.allLines")}
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}

// `id` is required rather than defaulted: two of these on one page would collide
// and the <Label htmlFor> would toggle the wrong box.
function HideZeroCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation("oee");

  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="text-sm font-normal">
        {t("common.hideOeeZero")}
      </Label>
    </div>
  );
}

export { ALL, HideZeroCheckbox, LineFilter, MonthFilter, ShiftFilter, SummaryFilter, YearFilter };
