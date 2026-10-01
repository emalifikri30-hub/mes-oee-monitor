import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MAX_ENTRIES, TagInput } from "@/components/ui/tag-input";

// The only net-new primitive in the downtime-edit change, and the one piece of it
// that is LOGIC rather than rendering — which is why it gets its own suite rather
// than being exercised only through the dialog.
//
// Every rule here mirrors core-api's `labelList` schema. The server stays the
// authority; this exists so an operator hears about a blank at the keyboard
// instead of via a 422 after pressing Save. A rule that drifted from the server's
// would show as an edit that looks accepted and is not.
afterEach(cleanup);

function setup(value: string[] = []) {
  const onChange = vi.fn();
  render(
    <TagInput
      id="t"
      itemLabel="reason"
      value={value}
      onChange={onChange}
      placeholder="Type a reason"
    />,
  );
  return { onChange, input: screen.getByRole("textbox") };
}

function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

describe("TagInput", () => {
  it.each([
    ["Enter", { key: "Enter" }],
    // Comma commits too, because it is what anyone typing a list reaches for —
    // and intercepting it is also what keeps a comma OUT of a label, which is the
    // failure a comma-separated text field would have had.
    ["comma", { key: "," }],
  ])("adds the draft on %s", (_label, event) => {
    const { onChange, input } = setup(["Machine_Stop"]);

    type(input, "Material_Jam");
    fireEvent.keyDown(input, event);

    // APPENDS. Element 0 of `reason` is the key the Pareto groups a stop under,
    // so a helpful sort here would silently re-bucket it.
    expect(onChange).toHaveBeenCalledWith(["Machine_Stop", "Material_Jam"]);
  });

  it("trims before adding", () => {
    const { onChange, input } = setup();

    type(input, "  Machine_Stop  ");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["Machine_Stop"]);
  });

  it.each([
    ["a blank draft", ""],
    // The hazard 0009's ck_dtle_reasons exists for: whitespace-only becomes a
    // Pareto bucket that is NOT the unlabelled one — a second empty bar beside
    // the real one.
    ["a whitespace-only draft", "   "],
    ["an over-long label", "x".repeat(256)],
  ])("refuses %s and clears the field", (_label, text) => {
    const { onChange, input } = setup();

    type(input, text);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    // Cleared rather than left stranded, so the visible result of pressing Enter
    // matches what happened.
    expect((input as HTMLInputElement).value).toBe("");
  });

  // A duplicate would make a Pareto bar overstate itself: the drill-down counts a
  // stop once per DISTINCT reason.
  it("refuses a duplicate", () => {
    const { onChange, input } = setup(["Machine_Stop"]);

    type(input, "Machine_Stop");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // Deliberately NOT case-folded. The write contract records that the reader
  // trims but does not case-fold, so folding here would make an operator's edit
  // disagree with every pipeline-written row.
  it("treats a case variant as a distinct entry", () => {
    const { onChange, input } = setup(["Machine_Stop"]);

    type(input, "machine_stop");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["Machine_Stop", "machine_stop"]);
  });

  // THE ONE THAT PREVENTS SILENT DATA LOSS. A label typed but never Entered would
  // otherwise vanish when the operator clicked Save, and the edit would appear to
  // have worked.
  it("commits the draft on blur", () => {
    const { onChange, input } = setup();

    type(input, "Material_Jam");
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(["Material_Jam"]);
  });

  it("removes an entry by its chip button", () => {
    const { onChange } = setup(["Machine_Stop", "Material_Jam"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove reason Machine_Stop" }));

    expect(onChange).toHaveBeenCalledWith(["Material_Jam"]);
  });

  // The only way to undo without reaching for a mouse.
  it("removes the last entry on backspace over an empty draft", () => {
    const { onChange, input } = setup(["Machine_Stop", "Material_Jam"]);

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith(["Machine_Stop"]);
  });

  it("leaves the list alone on backspace while typing", () => {
    const { onChange, input } = setup(["Machine_Stop"]);

    type(input, "Mat");
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // The cap shows as a STATE, not as a keyboard that has silently gone dead.
  it("disables the input at the maximum and says so", () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) => `reason-${i}`);
    const { input } = setup(full);

    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((input as HTMLInputElement).placeholder).toMatch(new RegExp(`${MAX_ENTRIES}`));
  });

  it("renders no list at all when empty", () => {
    setup();

    expect(screen.queryByRole("list")).toBeNull();
  });
});
