import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";

import { CATEGORY_LABEL } from "@/lib/downtime";
import { renderWithQuery } from "@/test/render";
import { downtimeItem } from "@/test/fixtures";
import { DowntimeEditDialog } from "@/components/report/downtime-edit-dialog";

import type { DowntimeEditResult, DowntimeListItem } from "@/lib/types";
import type { ReportAddress } from "@/lib/report-subject";
import type { Seed } from "@/test/render";

// The two catalogue reads are mocked as well as the write. They are REAL queries
// behind the dialog now, so leaving them unmocked would send axios at a BFF that
// is not there — an unhandled rejection per test, and an error state in every
// assertion that was not about one.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  editDowntime: vi.fn(),
  getDowntimeReasonOptions: vi.fn(),
  getDowntimeActionOptions: vi.fn(),
  createDowntimeAction: vi.fn(),
}));

const { editDowntime, getDowntimeReasonOptions, getDowntimeActionOptions, createDowntimeAction } =
  await import("@/lib/api");
const mocked = vi.mocked(editDowntime);
const mockedReasons = vi.mocked(getDowntimeReasonOptions);
const mockedActions = vi.mocked(getDowntimeActionOptions);
const mockedCreateAction = vi.mocked(createDowntimeAction);

// The line this report sits on. The Reason catalogue is scoped to it, which is
// the whole reason the dialog takes a workCenterId at all.
const WORK_CENTER_ID = 13;

const REASON_OPTIONS = [
  { id: 1, code: "MCH_BRK", name: "Machine Breakdown", category: "UNPLANNED" as const },
  { id: 2, code: "CHG_OVR", name: "Changeover", category: "PLANNED" as const },
];

const ACTION_OPTIONS = [{ id: 7, code: "replace_belt", name: "Replace Belt", color: "#f43f5e" }];

// A real AxiosError, so the component's isAxiosError guard is exercised rather
// than skipped — the same reasoning approve-report-dialog.test.tsx gives.
function axiosError(status: number, body: unknown = null): AxiosError {
  const err = new AxiosError("request failed");
  err.response = {
    status,
    statusText: "",
    data: body,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

// An editable stop: it HAS a source_event_id, unlike the fixture's default and
// unlike every row in the reporting database today.
function editable(overrides: Partial<DowntimeListItem> = {}): DowntimeListItem {
  return downtimeItem({
    sourceEventId: "evt-1",
    reason: ["Machine_Stop"],
    actions: ["Realigned"],
    detailReason: "belt slipped",
    ...overrides,
  });
}

function result(changed: DowntimeEditResult["changed"]): DowntimeEditResult {
  return { item: editable(), changed };
}

function render(
  row: DowntimeListItem = editable(),
  address: ReportAddress = { subject: "machine", grain: "shift", id: 7 },
  seed: Seed[] = [],
) {
  const onOpenChange = vi.fn();
  const { queryClient } = renderWithQuery(
    <DowntimeEditDialog
      row={row}
      address={address}
      workCenterId={WORK_CENTER_ID}
      open
      onOpenChange={onOpenChange}
    />,
    { seed },
  );
  return { onOpenChange, queryClient };
}

const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
const detailReason = () => screen.getByLabelText(/detail reason/i) as HTMLTextAreaElement;
// BY LABEL, not by role. There are now THREE comboboxes in this dialog — the
// category select plus the two catalogue pickers, which are `role="combobox"`
// because that is what an autocomplete text input is. A bare getByRole here
// matched one element before the pickers existed and throws now.
const category = () => screen.getByLabelText(/^category$/i);

beforeEach(() => {
  mockedReasons.mockResolvedValue(REASON_OPTIONS);
  mockedActions.mockResolvedValue(ACTION_OPTIONS);
});

afterEach(() => {
  cleanup();
  mocked.mockReset();
  mockedReasons.mockReset();
  mockedActions.mockReset();
  mockedCreateAction.mockReset();
});

describe("DowntimeEditDialog", () => {
  it("seeds every field from the row", () => {
    render();

    expect(category().textContent).toMatch(/unplanned/i);
    expect(screen.getByText("Machine_Stop")).toBeTruthy();
    expect(screen.getByText("Realigned")).toBeTruthy();
    expect(detailReason().value).toBe("belt slipped");
  });

  // A no-op edit would be answered 200 with nothing written, and a toast saying
  // "updated" over an unchanged row is a claim the UI should not make.
  it("disables Save until something changes", () => {
    render();

    expect(save().disabled).toBe(true);

    fireEvent.change(detailReason(), { target: { value: "chain jumped" } });

    expect(save().disabled).toBe(false);
  });

  // THE CONCURRENCY BASELINE IS THE POINT OF THE PAYLOAD'S SHAPE. The server binds
  // `baseline` into the UPDATE's WHERE, so it must be what the dialog OPENED with
  // — not what is currently in the inputs. Sending `next` twice would make the
  // guard tautological and two operators could silently revert each other.
  it("sends the values it opened with as the baseline, and the edits as next", async () => {
    mocked.mockResolvedValue(result(["detailReason"]));
    render();

    fireEvent.change(detailReason(), { target: { value: "chain jumped" } });
    fireEvent.click(save());

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    expect(mocked).toHaveBeenCalledWith("evt-1", {
      next: expect.objectContaining({ detailReason: "chain jumped" }),
      baseline: expect.objectContaining({ detailReason: "belt slipped" }),
    });
  });

  // '' back to null, matching the server. Two representations of "nothing here" is
  // how a field ends up rendering as blank instead of as an em dash.
  it("sends a cleared detail reason as null, not an empty string", async () => {
    mocked.mockResolvedValue(result(["detailReason"]));
    render();

    fireEvent.change(detailReason(), { target: { value: "" } });
    fireEvent.click(save());

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    expect(mocked.mock.calls[0]?.[1].next.detailReason).toBeNull();
  });

  it("closes on success", async () => {
    mocked.mockResolvedValue(result(["detailReason"]));
    const { onOpenChange } = render();

    fireEvent.change(detailReason(), { target: { value: "x" } });
    fireEvent.click(save());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // TABLE-DRIVEN, because a wrong-but-plausible error message is SILENT: the user
  // reads the wrong recovery and does the wrong thing. Keeping all four in one
  // case is what keeps them visible together.
  it.each([
    [400, /no stable id/i],
    [404, /no longer exists/i],
    [422, /rejected/i],
    // Anything unmapped falls back rather than showing a raw axios message.
    [500, /try again in a moment/i],
  ])("renders local copy for %i", async (status, expected) => {
    mocked.mockRejectedValue(axiosError(status));
    const { onOpenChange } = render();

    fireEvent.change(detailReason(), { target: { value: "x" } });
    fireEvent.click(save());

    expect(await screen.findByText(expected)).toBeTruthy();
    // The dialog must NOT close on error: the user is about to press the button
    // again and the message has to stay next to it.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // THE TWO STATUSES WHERE THE SERVER WORDS IT BETTER, and the only place in the
  // app that defers to server text.
  //
  //   409  names WHICH SHIFT is approved — a stop straddling midnight can be
  //        frozen by a shift that is not its own, so local copy would send
  //        somebody to the wrong report.
  //   412  says whether another OPERATOR or the PIPELINE got there first, which a
  //        status code cannot carry. Guessing would blame a colleague for a DAG.
  it.each([
    [409, "shift 3 has been approved; reopen it before editing this downtime"],
    [412, "the pipeline reloaded this downtime while you had it open"],
    [412, "another user changed this downtime while you had it open"],
  ])("renders the server's own message for %i", async (status, message) => {
    mocked.mockRejectedValue(axiosError(status, { data: null, error: message }));
    render();

    fireEvent.change(detailReason(), { target: { value: "x" } });
    fireEvent.click(save());

    expect(await screen.findByText(message)).toBeTruthy();
  });

  // Falls back rather than rendering an empty alert if the envelope ever arrives
  // without a message.
  it("falls back when a 412 carries no message", async () => {
    mocked.mockRejectedValue(axiosError(412, { data: null, error: null }));
    render();

    fireEvent.change(detailReason(), { target: { value: "x" } });
    fireEvent.click(save());

    expect(await screen.findByText(/try again in a moment/i)).toBeTruthy();
  });

  it("disables both buttons while the write is in flight", async () => {
    mocked.mockReturnValue(new Promise(() => {}));
    render();

    fireEvent.change(detailReason(), { target: { value: "x" } });
    fireEvent.click(save());

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /saving/i }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    // Cancel too: it would otherwise close the dialog over a write that is still
    // going to land.
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // Only a CATEGORY change makes the report's precomputed totals wrong, so only
  // that one earns the longer toast. Saying it for a reason edit would train
  // people to ignore it.
  it("states the consequence at the point of change", () => {
    render();

    expect(screen.getByText(/recalculated by the pipeline/i)).toBeTruthy();
    // And the ordering rule, which nothing else on screen would reveal.
    expect(screen.getByText(/first reason is the one the Pareto groups/i)).toBeTruthy();
  });
});

// The catalogue wiring, which is what replaced free-text entry on both fields.
//
// The pickers' own mechanics — filtering, keyboard, chips, create-on-Enter — are
// exercised in ui/option-tag-input.test.tsx. What is asserted HERE is what only
// the dialog can get wrong: that the Reason picker is scoped to THIS report's
// line, that the two fields are wired to different catalogues, and that a created
// action lands on the stop rather than merely in the catalogue.
describe("DowntimeEditDialog catalogues", () => {
  const reasonInput = () => screen.getByLabelText(/^reason$/i);
  const actionsInput = () => screen.getByLabelText(/^actions$/i);

  // THE SCOPE, and the reason the prop exists. An unscoped fetch would offer the
  // whole region's reasons — so a stop on the filler could be filed under a
  // palletiser reason, and reason[0] is the key the Availability Pareto groups
  // that stop under.
  it("fetches the reason catalogue for this report's line", async () => {
    render();

    await waitFor(() => expect(mockedReasons).toHaveBeenCalledWith(WORK_CENTER_ID));
  });

  it("offers this line's reasons, with the catalogue's own category as a hint", async () => {
    render();
    fireEvent.focus(reasonInput());

    await waitFor(() => expect(screen.getByText("Machine Breakdown")).toBeTruthy());
    expect(screen.getByText("Changeover")).toBeTruthy();
    // The hint is informational and does NOT drive the Category select above it:
    // a reason's catalogue category is its default, not a verdict about this stop.
    // Changeover is PLANNED upstream; the select stays on the stop's own
    // UNPLANNED.
    expect(screen.getByText(CATEGORY_LABEL.PLANNED)).toBeTruthy();
    expect(category().textContent).toMatch(/unplanned/i);
  });

  // The two fields read DIFFERENT catalogues, and the action one is unscoped —
  // upstream has no per-line scoping for actions.
  it("offers actions from the action catalogue, not the reason one", async () => {
    render();
    fireEvent.focus(actionsInput());

    await waitFor(() => expect(screen.getByText("Replace Belt")).toBeTruthy());
    expect(mockedActions).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("option", { name: /machine breakdown/i })).toBeNull();
  });

  // Picking from the catalogue stores the NAME. `downtime_reports.reason` is a
  // jsonb string array the pipeline also writes into, so there is no id to store.
  it("writes the chosen reason's name into the payload", async () => {
    mocked.mockResolvedValue(result(["reason"]));
    render();

    fireEvent.focus(reasonInput());
    await waitFor(() => expect(screen.getByText("Machine Breakdown")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("option", { name: /machine breakdown/i }));

    fireEvent.click(save());

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    expect(mocked).toHaveBeenCalledWith("evt-1", {
      next: expect.objectContaining({ reason: ["Machine_Stop", "Machine Breakdown"] }),
      baseline: expect.objectContaining({ reason: ["Machine_Stop"] }),
    });
  });

  // THE REASON FIELD IS CLOSED. An uncatalogued reason must not become a bar on
  // the Availability Pareto that no line's catalogue owns — so Enter does nothing
  // and Save stays disabled, because nothing changed.
  it("refuses to add a reason that is not in this line's catalogue", async () => {
    render();
    await waitFor(() => expect(mockedReasons).toHaveBeenCalled());

    fireEvent.focus(reasonInput());
    fireEvent.change(reasonInput(), { target: { value: "Something Uncatalogued" } });
    fireEvent.keyDown(reasonInput(), { key: "Enter" });

    expect(screen.queryByText("Something Uncatalogued")).toBeNull();
    expect(save().disabled).toBe(true);
  });

  // THE ACTIONS FIELD IS OPEN, and the created action has to land on the STOP —
  // the operator pressed Enter to use it, not to file it in a catalogue.
  //
  // The chip is added from the row the SERVER returned, not optimistically off
  // what was typed: a create that 409s must not leave a chip standing for an
  // action that does not exist, which would then be saved onto the stop.
  it("creates an unmatched action and adds it to this stop", async () => {
    mockedCreateAction.mockResolvedValue({
      id: 9,
      code: "realigned_belt",
      name: "Realigned Belt",
      color: "#f43f5e",
    });
    render();
    await waitFor(() => expect(mockedActions).toHaveBeenCalled());

    fireEvent.focus(actionsInput());
    fireEvent.change(actionsInput(), { target: { value: "Realigned Belt" } });
    fireEvent.keyDown(actionsInput(), { key: "Enter" });

    // Code slugified from the name, colour defaulted to rose — the operator is
    // mid-way through recording a stop and is not asked for either.
    // Asserted on the first ARGUMENT rather than with toHaveBeenCalledWith:
    // react-query hands a mutationFn `(variables, context)`, so matching the full
    // call would pin this test to that second parameter.
    await waitFor(() => expect(mockedCreateAction).toHaveBeenCalledTimes(1));
    expect(mockedCreateAction.mock.calls[0][0]).toEqual({
      name: "Realigned Belt",
      code: "realigned_belt",
      color: "#f43f5e",
    });
    await waitFor(() => expect(screen.getByText("Realigned Belt")).toBeTruthy());
    expect(save().disabled).toBe(false);
  });

  it("leaves no chip behind when the create fails, and says so beside the field", async () => {
    mockedCreateAction.mockRejectedValue(axiosError(409));
    render();
    await waitFor(() => expect(mockedActions).toHaveBeenCalled());

    fireEvent.focus(actionsInput());
    fireEvent.change(actionsInput(), { target: { value: "Realigned Belt" } });
    fireEvent.keyDown(actionsInput(), { key: "Enter" });

    await waitFor(() => expect(screen.getByText(/could not create that action/i)).toBeTruthy());
    // No chip, and therefore nothing to save: a phantom action must never reach
    // the stop.
    expect(screen.queryByRole("button", { name: /remove action Realigned Belt/i })).toBeNull();
    expect(save().disabled).toBe(true);
  });

  // Almost every stop on screen was labelled by the pipeline long before this
  // picker existed, and a reason may have been renamed upstream since. Dropping
  // such a chip would silently rewrite an operator's record.
  it("keeps a pipeline-written reason that is not in the catalogue", async () => {
    render();
    await waitFor(() => expect(mockedReasons).toHaveBeenCalled());

    expect(screen.getByText("Machine_Stop")).toBeTruthy();
    expect(save().disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WHICH SUBJECT'S FEED GOES STALE — the arm TODOS §60 said would be silent
// ---------------------------------------------------------------------------
//
// useEditDowntime picks the activity key from the address. It read
// `subject === "line" ? … : grain === "shift" ? … : period…`, which is correct for
// TWO subjects and silently wrong at three: a SKU address carries `grain: "day"`,
// so it fell through to the MACHINE PERIOD arm and invalidated a machine's key with
// a SKU report's id. §60 wrote the trigger condition verbatim — "the moment one
// exists, that arm must be filled in, and NOTHING WILL FAIL IF IT IS NOT" — which
// is why this is asserted rather than left to the switch's `never`.
//
// ASSERTED THROUGH THE CACHE, not through a spy: the bug is in which KEY is named,
// and no spy on the fetchers can see that. `isInvalidated` on the seeded entries is
// the only thing that can.
describe("DowntimeEditDialog — the feed it marks stale", () => {
  const seedFeeds = (): Seed[] => [
    { queryKey: ["sku-day-report-activity", 7], data: { entries: [], sources: [] } },
    { queryKey: ["day-report-activity", 7], data: { entries: [], sources: [] } },
    { queryKey: ["work-center-shift-report-activity", 7], data: { entries: [], sources: [] } },
  ];

  const stale = (client: ReturnType<typeof render>["queryClient"], key: unknown[]) =>
    client.getQueryState(key)?.isInvalidated === true;

  it("marks the SKU feed stale after an edit made from a SKU report", async () => {
    mocked.mockResolvedValue(result([]));

    const { queryClient } = render(
      editable(),
      { subject: "sku", grain: "day", id: 7 },
      seedFeeds(),
    );

    fireEvent.change(detailReason(), { target: { value: "changed" } });
    fireEvent.click(save());

    await waitFor(() => {
      expect(stale(queryClient, ["sku-day-report-activity", 7])).toBe(true);
    });

    // AND NOT THE MACHINE'S, which is the half the old ternary got wrong: the
    // machine day report sharing id 7 is a different row from a different
    // sequence, and refetching its feed leaves the operator's own stale.
    expect(stale(queryClient, ["day-report-activity", 7])).toBe(false);
  });

  it("marks the machine feed stale after an edit made from a machine report", async () => {
    mocked.mockResolvedValue(result([]));

    const { queryClient } = render(
      editable(),
      { subject: "machine", grain: "day", id: 7 },
      seedFeeds(),
    );

    fireEvent.change(detailReason(), { target: { value: "changed" } });
    fireEvent.click(save());

    await waitFor(() => {
      expect(stale(queryClient, ["day-report-activity", 7])).toBe(true);
    });
    expect(stale(queryClient, ["sku-day-report-activity", 7])).toBe(false);
  });

  it("marks the line feed stale after an edit made from a line shift report", async () => {
    mocked.mockResolvedValue(result([]));

    const { queryClient } = render(
      editable(),
      { subject: "line", grain: "shift", id: 7 },
      seedFeeds(),
    );

    fireEvent.change(detailReason(), { target: { value: "changed" } });
    fireEvent.click(save());

    await waitFor(() => {
      expect(stale(queryClient, ["work-center-shift-report-activity", 7])).toBe(true);
    });
    expect(stale(queryClient, ["sku-day-report-activity", 7])).toBe(false);
    expect(stale(queryClient, ["day-report-activity", 7])).toBe(false);
  });
});
