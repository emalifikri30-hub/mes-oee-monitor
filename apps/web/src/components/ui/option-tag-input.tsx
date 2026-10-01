import { XIcon } from "lucide-react";
import * as React from "react";

import { MAX_ENTRIES, MAX_LENGTH } from "@/components/ui/tag-input";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// A list of labels chosen from a MASTER-DATA CATALOGUE, edited as chips.
//
// WHY THIS EXISTS BESIDE ui/tag-input.tsx RATHER THAN REPLACING IT
//
// TagInput accepts any string an operator types. That was the right control when
// `reason` and `actions` had no catalogue behind them, and it is the wrong one
// now: free text means "Machine Breakdown", "machine breakdown" and "Mchn
// Brkdwn" become three bars on the Availability Pareto describing one failure,
// and nothing on screen ever says they are the same. This control offers the
// catalogue instead. TagInput stays because it is still what an uncatalogued
// list wants, and its MAX_ENTRIES / MAX_LENGTH — which mirror core-api's
// `labelList` — are imported rather than re-declared, so the two controls cannot
// drift into two different caps.
//
// WHAT IS STORED IS THE NAME, NOT THE ID. `downtime_reports.reason` and
// `.actions` are jsonb arrays of plain strings that the pipeline also writes
// into, so there is no id column to put an id in — and element 0 of `reason` is
// the label the Pareto groups on, which a code would render as a code on every
// bar. The catalogue is therefore a source of SUGGESTIONS with a stable
// vocabulary, not a foreign key.
//
// A CHIP WHOSE NAME IS NOT IN THE CATALOGUE STILL RENDERS, and this is the case
// that must not regress. Almost every stop on screen was labelled by the
// pipeline, from Silver, long before this picker existed; a reason may also have
// been renamed or retired upstream since. Dropping such a chip — or refusing to
// re-save it — would silently rewrite an operator's record on their behalf. They
// render marked (see `unknown` below) so the operator can see the difference,
// and they remain removable.
//
// ORDER IS MEANINGFUL AND IS NEVER SORTED, exactly as in TagInput: element 0 of
// `reason` is the primary reason. Selections append.
//
// CREATE-ON-ENTER IS OPT-IN, via `onCreate`. Actions pass it; reasons deliberately
// do not — see the Reason field in downtime-edit-dialog.tsx.

// What the pickers render. Both catalogues are projected into this shape by the
// dialog rather than the component knowing about either one.
type AutocompleteOption = {
  id: number;
  name: string;
  // A muted note beside the name — a reason's category. Purely informational.
  hint?: string;
  // `#rrggbb`, used to tint the chip. Actions carry one; reasons do not.
  color?: string;
};

// Case- and whitespace-insensitive, because "belt jam" and "Belt Jam " are the
// same catalogue entry to everyone except `===`.
function normalise(value: string): string {
  return value.trim().toLowerCase();
}

type OptionTagInputProps = {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  options: AutocompleteOption[];
  // Labels the chip's remove button, e.g. "reason" -> "Remove reason Belt Jam".
  itemLabel: string;
  placeholder?: string;
  disabled?: boolean;
  // The catalogue is still loading / could not be loaded. Rendered as distinct
  // messages inside the list, because "no reasons match" and "the catalogue did
  // not load" would otherwise look identical to an operator — and the second one
  // is not something retyping will fix.
  isPending?: boolean;
  isError?: boolean;
  // When supplied, an unmatched entry may be CREATED by pressing Enter. Absent
  // means the catalogue is closed and an unmatched search yields nothing.
  onCreate?: (name: string) => void;
  creating?: boolean;
  // Sentence shown under the input describing what Enter does. Stated per field
  // rather than inferred, because "press Enter to add" and "pick from the list"
  // are opposite instructions and getting it wrong teaches the wrong habit.
  helpText?: string;
};

function OptionTagInput({
  id,
  value,
  onChange,
  options,
  itemLabel,
  placeholder,
  disabled = false,
  isPending = false,
  isError = false,
  onCreate,
  creating = false,
  helpText,
}: OptionTagInputProps) {
  const [draft, setDraft] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);

  const full = value.length >= MAX_ENTRIES;
  const busy = disabled || creating;

  // Already-chosen names, for both the filter below and the chip marking.
  const chosen = React.useMemo(() => new Set(value.map(normalise)), [value]);
  const catalogue = React.useMemo(
    () => new Map(options.map((option) => [normalise(option.name), option])),
    [options],
  );

  // Matches on a plain substring rather than a fuzzy score. The catalogues are
  // dozens of rows and the operator knows what they are looking for; a fuzzy
  // match's job is to rank a thousand candidates, and here it would only make
  // "why is THAT top of the list" a question worth asking.
  //
  // Already-chosen options are filtered OUT, not disabled: a list that offers
  // what is already a chip above it is offering a no-op.
  const matches = React.useMemo(() => {
    const needle = normalise(draft);
    return options.filter(
      (option) =>
        !chosen.has(normalise(option.name)) &&
        (needle === "" || option.name.toLowerCase().includes(needle)),
    );
  }, [options, draft, chosen]);

  // Whether Enter would CREATE rather than select: the catalogue is open, the
  // draft is a real value, and nothing in the catalogue already carries that name.
  //
  // Checked against the WHOLE catalogue rather than against `matches`, which has
  // the chosen entries filtered out — otherwise re-typing a name already on a
  // chip would look uncatalogued and offer to create a duplicate the server
  // would 409.
  const trimmed = draft.trim();
  const canCreate =
    onCreate !== undefined &&
    trimmed !== "" &&
    trimmed.length <= MAX_LENGTH &&
    !catalogue.has(normalise(trimmed)) &&
    !chosen.has(normalise(trimmed)) &&
    !full;

  // Clamped rather than reset, so the highlight survives a keystroke that only
  // narrows the list.
  const activeIndex = matches.length === 0 ? -1 : Math.min(highlight, matches.length - 1);

  function add(name: string): void {
    if (full || chosen.has(normalise(name))) {
      setDraft("");
      return;
    }
    onChange([...value, name]);
    setDraft("");
    setHighlight(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Only meaningful with a list to walk, and preventing the default is what
      // stops the caret jumping to the start/end of the draft as it moves.
      if (matches.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        // Wraps, so a short list is walkable without changing direction.
        return (next + matches.length) % matches.length;
      });
      return;
    }

    if (event.key === "Enter") {
      // ALWAYS prevented, matched or not. Enter inside a dialog submits the
      // form, so letting it through would save the edit with the draft
      // unadded — the exact silent data loss TagInput's onBlur exists to stop.
      event.preventDefault();
      if (activeIndex >= 0 && open) {
        add(matches[activeIndex].name);
        return;
      }
      if (canCreate) {
        onCreate?.(trimmed);
        return;
      }
      // No match and no create: deliberately does NOTHING and leaves the draft
      // in place. Clearing it would look like the value had been accepted.
      return;
    }

    if (event.key === "Escape" && open) {
      // Stopped as well as prevented: Radix's Dialog closes on Escape, and an
      // operator dismissing the suggestion list does not mean to discard their
      // edit.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }

    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const listId = `${id}-listbox`;
  const showList = open && !busy;

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${itemLabel} list`}>
          {value.map((item) => {
            const option = catalogue.get(normalise(item));
            // Not in the catalogue: pipeline-written, renamed upstream, or
            // retired. Marked, never hidden — see the header.
            const unknown = option === undefined;
            return (
              <li key={item}>
                <Badge
                  variant="secondary"
                  className={cn("gap-1 pr-1", unknown && "border-dashed")}
                  title={unknown ? `${item} is not in the current catalogue` : undefined}
                >
                  {option?.color !== undefined && (
                    <span
                      aria-hidden
                      style={{ backgroundColor: option.color }}
                      className="size-2 shrink-0 rounded-full"
                    />
                  )}
                  {item}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onChange(value.filter((entry) => entry !== item))}
                    aria-label={`Remove ${itemLabel} ${item}`}
                    className={cn(
                      "rounded-sm opacity-70 transition-opacity hover:opacity-100",
                      "focus-visible:ring-[2px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      "disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {/* `relative` anchors the list. Not a Radix Popover: this lives inside a
          Dialog, and a second focus-trapping layer over an input is how a
          keyboard-driven picker starts losing keystrokes. */}
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && activeIndex >= 0 ? `${listId}-${matches[activeIndex].id}` : undefined
          }
          autoComplete="off"
          value={draft}
          disabled={busy || full}
          placeholder={full ? `${MAX_ENTRIES} is the maximum` : placeholder}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          // NO COMMIT ON BLUR, which is the one behaviour deliberately dropped
          // from TagInput. There it was right: any string was valid, so an
          // uncommitted draft was a real value being lost. Here a draft is a
          // SEARCH — committing it on blur would add whatever half-word the
          // operator had typed when they reached for the Save button, as a label
          // that is in no catalogue.
          //
          // The timeout is the standard one for a list that must survive the
          // mousedown that selects from it: blur fires before click.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
        />

        {showList && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${itemLabel} suggestions`}
            className={cn(
              "absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1",
              "text-popover-foreground shadow-md",
            )}
          >
            {isPending ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</li>
            ) : isError ? (
              <li className="px-2 py-1.5 text-sm text-destructive">
                Could not load the {itemLabel} list.
              </li>
            ) : matches.length === 0 ? (
              // The empty state carries the ONE instruction that differs between
              // the two fields, so an operator never has to guess whether Enter
              // will do something.
              <li className="px-2 py-1.5 text-sm text-muted-foreground">
                {trimmed === ""
                  ? `No ${itemLabel}s available.`
                  : canCreate
                    ? `No match. Press Enter to create “${trimmed}”.`
                    : `No ${itemLabel} matches “${trimmed}”.`}
              </li>
            ) : (
              matches.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    id={`${listId}-${option.id}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    // `onMouseDown` rather than `onClick`: the input's blur fires
                    // first and would otherwise close the list out from under the
                    // pointer.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      add(option.name);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                      index === activeIndex && "bg-accent text-accent-foreground",
                    )}
                  >
                    {option.color !== undefined && (
                      <span
                        aria-hidden
                        style={{ backgroundColor: option.color }}
                        className="size-2.5 shrink-0 rounded-full"
                      />
                    )}
                    <span className="truncate">{option.name}</span>
                    {option.hint !== undefined && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {helpText !== undefined && <p className="text-xs text-muted-foreground">{helpText}</p>}
    </div>
  );
}

export { OptionTagInput };
export type { AutocompleteOption, OptionTagInputProps };
