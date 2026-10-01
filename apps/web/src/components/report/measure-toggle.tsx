import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Which measure a Pareto's bars and cumulative line are built from.
//
// A genuine choice between views of one dataset, not a toggle — hence radios.
// Client-side: the whole result set is already in the browser, so re-ranking is a
// reduce over a handful of numbers rather than a round trip.
//
// GENERIC OVER THE MEASURE UNION, because the two families that render this have
// different ones and must keep them apart: the downtime cards offer `duration` and
// `frequency`, the Quality Loss card offers four, and lib/pareto.ts explains why
// widening either union to cover both would be a silent bug rather than a
// convenience. The component itself does not care — it renders whatever list it is
// handed.
type MeasureOption<TMeasure extends string> = { value: TMeasure; label: string };

function MeasureToggle<TMeasure extends string>({
  measure,
  onChange,
  options,
  idPrefix,
  ariaLabel,
}: {
  measure: TMeasure;
  onChange: (next: TMeasure) => void;
  options: readonly MeasureOption<TMeasure>[];
  // REQUIRED, with no default. These are `htmlFor` targets and an id has to be
  // unique in a document. Radix unmounts an inactive TabsContent, so in the app
  // only one card is ever mounted and a bare "pareto-duration" would work — but
  // reason-pareto-card.test.tsx mounts two cards at once to prove they do not
  // share a cache entry, and there a duplicated id silently binds a label to the
  // wrong card's radio. A default would make that failure reachable again by
  // omission; requiring the prop makes it a compile error.
  //
  // The callers' natural prefixes cannot collide: the downtime cards derive
  // theirs from the DowntimeCategory, and "quality" is not one.
  idPrefix: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation("oee");
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-muted-foreground">{t("report.sortBy")}</span>
      <RadioGroup
        value={measure}
        onValueChange={(next) => onChange(next as TMeasure)}
        className="flex items-center gap-3"
        aria-label={ariaLabel}
      >
        {options.map((option) => (
          <div key={option.value} className="flex items-center gap-1.5">
            <RadioGroupItem value={option.value} id={`${idPrefix}-${option.value}`} />
            <Label htmlFor={`${idPrefix}-${option.value}`} className="text-xs font-normal">
              {option.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}

export { MeasureToggle };
export type { MeasureOption };
