import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { OptionTagInput } from "@/components/ui/option-tag-input";

import type { AutocompleteOption } from "@/components/ui/option-tag-input";

// The catalogue-backed picker behind the downtime edit dialog's Reason and
// Actions fields, and the piece of that change which is LOGIC rather than
// rendering — so it gets its own suite, exactly as ui/tag-input.tsx does.
//
// The two fields differ in ONE prop, `onCreate`, and that difference is the whole
// design: an unmatched reason yields nothing (the Availability Pareto groups on
// reason[0], so an invented one is a bar no line's catalogue owns), while an
// unmatched action is created (an operator recording what they did will not stop
// to open another app). Both halves are asserted below, because a regression in
// either direction is silent — a reason field that started accepting free text
// would look like it was working.
afterEach(cleanup);

const OPTIONS: AutocompleteOption[] = [
  { id: 1, name: "Machine Breakdown", hint: "Unplanned" },
  { id: 2, name: "Belt Jam", hint: "Unplanned" },
  { id: 3, name: "Changeover", hint: "Planned" },
];

// The Reason field's shape by default: no `onCreate`. The Actions field's helper
// is setupCreatable below.
function setup(props: Partial<React.ComponentProps<typeof OptionTagInput>> = {}) {
  const onChange = vi.fn();
  render(
    <OptionTagInput
      id="t"
      itemLabel="reason"
      value={[]}
      onChange={onChange}
      options={OPTIONS}
      placeholder="Search"
      {...props}
    />,
  );
  return { onChange, input: screen.getByRole("combobox") };
}

function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

const optionNames = () =>
  screen.queryAllByRole("option").map((node) => node.textContent?.replace(/Unplanned|Planned/, ""));

describe("OptionTagInput suggestions", () => {
  it("offers the whole catalogue on focus, before anything is typed", () => {
    const { input } = setup();

    fireEvent.focus(input);

    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters on a case-insensitive substring rather than a prefix", () => {
    const { input } = setup();
    fireEvent.focus(input);

    type(input, "jam");

    expect(optionNames()).toEqual(["Belt Jam"]);
  });

  it("adds the option's name, not its id or its label text", () => {
    const { onChange, input } = setup();
    fireEvent.focus(input);
    type(input, "belt");

    fireEvent.mouseDown(screen.getByRole("option"));

    expect(onChange).toHaveBeenCalledWith(["Belt Jam"]);
  });

  // A list offering what is already a chip above it is offering a no-op.
  it("hides options that are already chosen", () => {
    const { input } = setup({ value: ["Belt Jam"] });

    fireEvent.focus(input);

    expect(optionNames()).toEqual(["Machine Breakdown", "Changeover"]);
  });

  // "Loading" and "could not load" look identical to an operator if both render
  // as an empty list — and only one of them is fixed by retyping.
  it("distinguishes loading from a failed catalogue", () => {
    const { input } = setup({ isPending: true });
    fireEvent.focus(input);
    expect(screen.getByText(/loading/i)).toBeTruthy();

    cleanup();
    const second = setup({ isError: true });
    fireEvent.focus(second.input);
    expect(screen.getByText(/could not load/i)).toBeTruthy();
  });
});

describe("OptionTagInput keyboard", () => {
  it("selects the highlighted option on Enter", () => {
    const { onChange, input } = setup();
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["Belt Jam"]);
  });

  it("wraps the highlight so a short list is walkable in one direction", () => {
    const { onChange, input } = setup();
    fireEvent.focus(input);

    // 0 -> up wraps to the last option.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["Changeover"]);
  });

  it("removes the last chip on Backspace with an empty draft", () => {
    const { onChange, input } = setup({ value: ["Belt Jam", "Changeover"] });

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith(["Belt Jam"]);
  });

  it("leaves the chips alone when Backspace has a draft to delete", () => {
    const { onChange, input } = setup({ value: ["Belt Jam"] });
    type(input, "cha");

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // A draft here is a SEARCH, not a value. TagInput commits on blur because any
  // string was valid there; doing it here would add whatever half-word the
  // operator had typed when they reached for Save, as a label in no catalogue.
  it("does NOT commit the draft on blur", () => {
    vi.useFakeTimers();
    const { onChange, input } = setup();
    type(input, "Belt");

    fireEvent.blur(input);
    vi.advanceTimersByTime(200);

    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("OptionTagInput without onCreate (the Reason field)", () => {
  // THE CENTRAL RULE OF THE REASON FIELD. Free text here becomes a bar on the
  // Availability Pareto that no line's catalogue owns.
  it("does nothing on Enter when nothing matches", () => {
    const { onChange, input } = setup();
    fireEvent.focus(input);
    type(input, "Something Nobody Catalogued");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the draft in place, rather than clearing it as if accepted", () => {
    const { input } = setup();
    fireEvent.focus(input);
    type(input, "Nope");

    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLInputElement).value).toBe("Nope");
  });

  it("says the search matched nothing, and does not offer to create", () => {
    const { input } = setup();
    fireEvent.focus(input);

    type(input, "Nope");

    expect(screen.getByText(/no reason matches/i)).toBeTruthy();
    expect(screen.queryByText(/press enter to create/i)).toBeNull();
  });
});

// The Actions field: `onCreate` supplied, so an unmatched name is created rather
// than dropped.
//
// Its own helper because the mock has to EXIST before setup() is called — it is
// a prop, not something setup() invents — and reading it back off setup()'s
// return in the same destructuring is a temporal-dead-zone error.
function setupCreatable(props: Partial<React.ComponentProps<typeof OptionTagInput>> = {}) {
  const onCreate = vi.fn();
  const { onChange, input } = setup({ itemLabel: "action", onCreate, ...props });
  return { onChange, onCreate, input };
}

describe("OptionTagInput with onCreate (the Actions field)", () => {
  it("offers to create the unmatched name and does so on Enter", () => {
    const { onCreate, input } = setupCreatable();
    fireEvent.focus(input);

    type(input, "  Realigned Belt  ");

    expect(screen.getByText(/press enter to create/i)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });

    // TRIMMED. The name is both the value stored on the downtime and the seed for
    // the slugified code, so trailing space would produce a padded label AND a
    // different code from the same typed word.
    expect(onCreate).toHaveBeenCalledWith("Realigned Belt");
  });

  // Selecting beats creating whenever the list has a highlight: otherwise
  // arrowing to an option and pressing Enter would create a duplicate of it.
  it("selects the highlighted option rather than creating", () => {
    const { onChange, onCreate, input } = setupCreatable();
    fireEvent.focus(input);
    type(input, "belt");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["Belt Jam"]);
    expect(onCreate).not.toHaveBeenCalled();
  });

  // Checked against the WHOLE catalogue, not the filtered list — which has the
  // chosen entries removed. Without that, re-typing a name already on a chip
  // looks uncatalogued and offers to create a duplicate the server answers 409.
  it("does not offer to create a name that is already a chip", () => {
    const { onCreate, input } = setupCreatable({ value: ["Belt Jam"] });
    fireEvent.focus(input);

    type(input, "Belt Jam");

    expect(screen.queryByText(/press enter to create/i)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not offer to create a name the catalogue already holds, in any case", () => {
    const { input } = setupCreatable();
    fireEvent.focus(input);

    type(input, "belt jam");

    expect(screen.queryByText(/press enter to create/i)).toBeNull();
  });

  it("disables the input while a create is in flight", () => {
    const { input } = setupCreatable({ creating: true });

    expect((input as HTMLInputElement).disabled).toBe(true);
  });
});

describe("OptionTagInput chips", () => {
  // THE CASE THAT MUST NOT REGRESS. Almost every stop on screen was labelled by
  // the pipeline, from Silver, long before this picker existed — and a reason may
  // have been renamed or retired upstream since. Dropping such a chip would
  // silently rewrite an operator's record on their behalf.
  it("renders a chip whose name is not in the catalogue, and keeps it removable", () => {
    const { onChange } = setup({ value: ["Machine_Stop"] });

    expect(screen.getByText("Machine_Stop")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /remove reason Machine_Stop/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("marks an uncatalogued chip so the operator can see the difference", () => {
    setup({ value: ["Machine_Stop", "Belt Jam"] });

    expect(screen.getByTitle(/Machine_Stop is not in the current catalogue/i)).toBeTruthy();
    expect(screen.queryByTitle(/Belt Jam is not in the current catalogue/i)).toBeNull();
  });

  // Element 0 of `reason` is the key the Pareto groups on, so a helpful
  // alphabetical sort would silently re-bucket the stop. Selections append.
  it("appends rather than sorting", () => {
    const { onChange, input } = setup({ value: ["Changeover"] });
    fireEvent.focus(input);
    type(input, "belt");

    fireEvent.mouseDown(screen.getByRole("option"));

    expect(onChange).toHaveBeenCalledWith(["Changeover", "Belt Jam"]);
  });
});
