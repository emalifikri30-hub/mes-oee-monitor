import { XIcon } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// A list of short labels, edited as chips.
//
// WHY THIS EXISTS AT ALL. `reason` and `actions` on a downtime are jsonb ARRAYS,
// and components/ui/ has no combobox and no chips control. A comma-separated text
// input was the cheaper alternative and is lossy in exactly the wrong place: a
// reason containing a comma would split into two, and the first element of
// `reason` is the key the Availability Pareto groups on — so the stop would move
// to a bar that does not exist.
//
// THE RULES ARE THE SERVER'S, MIRRORED — not invented here. core-api's schema
// trims, rejects blanks, dedupes preserving FIRST occurrence, and caps the list;
// this does the same so the operator is told at the keyboard rather than by a 422
// after pressing Save. The server remains the authority: nothing here is a
// substitute for it, and a mismatch surfaces as the 422 the dialog already
// renders.
//
// ORDER IS MEANINGFUL AND IS NEVER SORTED. Element 0 of `reason` is the primary
// reason, so a helpful alphabetical sort would silently re-bucket the stop.
// Additions append.

// Matches core-api's `labelList`. Duplicated rather than shared because there is
// no schema package between the two apps — and the cap being visible here is what
// lets the input stop accepting instead of failing on submit.
const MAX_ENTRIES = 20;
const MAX_LENGTH = 255;

type TagInputProps = {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  // Labels the chip's remove button, e.g. "reason" -> "Remove reason Machine_Stop".
  itemLabel: string;
};

function TagInput({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  itemLabel,
}: TagInputProps) {
  const [draft, setDraft] = React.useState("");

  const full = value.length >= MAX_ENTRIES;

  function commit() {
    const trimmed = draft.trim();
    // Every rejection clears the draft rather than leaving it stranded: a blank
    // is nothing to keep, and a duplicate is already in the list above the input,
    // so the visible result of pressing Enter is correct either way.
    if (trimmed === "" || trimmed.length > MAX_LENGTH || value.includes(trimmed) || full) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // Enter and comma both commit. Comma because it is what anyone typing a list
    // reaches for, and intercepting it is also what keeps a comma out of a label
    // — which is the failure the comma-separated input would have had.
    if (event.key === "Enter" || event.key === ",") {
      // Enter inside a dialog would otherwise submit the form, saving the edit
      // with the draft still unadded.
      event.preventDefault();
      commit();
      return;
    }
    // Backspace on an empty draft removes the last chip, which is the behaviour
    // every chips input has and the only way to undo without reaching for a mouse.
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${itemLabel} list`}>
          {value.map((item) => (
            <li key={item}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {item}
                <button
                  type="button"
                  disabled={disabled}
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
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={draft}
        disabled={disabled || full}
        // `full` disables the input rather than hiding it, so the cap is visible
        // as a state instead of the keyboard silently going dead.
        placeholder={full ? `${MAX_ENTRIES} is the maximum` : placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        // COMMIT ON BLUR, which is the one that stops silent data loss: a typed
        // label the operator never pressed Enter on would otherwise vanish when
        // they clicked Save, and the edit would appear to have worked.
        onBlur={commit}
      />
    </div>
  );
}

export { MAX_ENTRIES, MAX_LENGTH, TagInput };
