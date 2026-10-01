import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen } from "@testing-library/react";

import { QualityEntryView } from "@/components/report/quality-entry-view";
import { renderWithQuery } from "@/test/render";

import type { ComponentProps } from "react";
import type { QualityEntryDraft } from "@/lib/types";

// The entry form, and the first test it has ever had.
//
// IT WAS UNTESTED WHILE IT TOOK A REPORT, and that is not a coincidence: a
// component that calls its own useMutation and three of its own queries can only
// be exercised by standing up all of them. Taking the mutation as a RESULT and the
// catalogues as data is what makes these assertions one render each — the reason
// confirm-write-dialog.tsx's rule ("takes the MUTATION RESULT") exists.
//
// WHAT IS PINNED HERE IS THE TWO MODES. The form serves a LINE report, where the
// operator picks a SKU, and a SKU report, where the report names one. Those two
// differ in three props and nothing else, and the fixed mode is the one that could
// regress into a picker offering choices the server would refuse.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getRejectReasonOptions: vi.fn().mockResolvedValue([{ id: 2, code: "R1", name: "Burst seal" }]),
  getLineProductOptions: vi.fn().mockResolvedValue([{ id: 9, code: "SKU-C", name: "SKU C" }]),
  getProductDetail: vi.fn(),
}));

const { getLineProductOptions, getProductDetail } = await import("@/lib/api");

const PACKAGES = {
  id: 4,
  code: "SKU-A",
  name: "SKU A",
  packages: [
    { id: 1, main: true, sortOrder: 0, factorToBase: 1, uom: { id: 3, code: "BAG", name: "Bag" } },
    {
      id: 2,
      main: false,
      sortOrder: 1,
      factorToBase: 12,
      uom: { id: 8, code: "CTN", name: "Carton" },
    },
  ],
};

function fakeMutation() {
  const mutate = vi.fn();
  return {
    mutate,
    mutation: {
      mutate,
      isPending: false,
      error: null,
      reset: vi.fn(),
    } as never,
  };
}

const MACHINES = [{ workUnitId: 5, workUnitName: "Vertical Packer" }];

// Everything but the mutation, which each test builds so it can inspect `mutate`.
// `sku` is REQUIRED here rather than defaulted, because which mode the form is in
// is the thing every test below is about — a default would let a case silently
// assert the wrong one.
type ViewProps = Omit<ComponentProps<typeof QualityEntryView>, "mutation">;

function props(over: Pick<ViewProps, "sku"> & Partial<ViewProps>): ViewProps {
  return {
    kind: "reject",
    open: true,
    onOpenChange: vi.fn(),
    workCenterId: 3,
    infeedUomCode: "BAG",
    machines: MACHINES,
    fixedShift: null,
    datePicker: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QualityEntryView — a fixed SKU", () => {
  // THE REPORT IS ONE SKU, so this is a read-only field and not a list of one —
  // the same call the `noPackages` unit input makes. A picker here would offer
  // products the server refuses (resolveProductId 400s a mismatch).
  it("shows the product as a read-only field, with no combobox", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    const field = screen.getByLabelText("SKU");
    expect(field.tagName).toBe("INPUT");
    expect((field as HTMLInputElement).value).toBe("SKU A");
    expect((field as HTMLInputElement).readOnly).toBe(true);
  });

  // THE FIELD STAYS IN PLACE AND ABOVE THE UNIT. It is not removed, because the
  // unit options ARE that product's packages[] and hiding the product leaves them
  // unexplained — the SKU-BEFORE-UNIT rule the file's header defends.
  it("keeps the SKU above the unit", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    const labels = screen.getAllByText(/^(SKU|Package \/ Unit)$/).map((n) => n.textContent);
    expect(labels).toEqual(["SKU", "Package / Unit"]);
  });

  // THE CASCADE STILL RUNS, off the fixed product rather than off a selection.
  // Without this the unit picker would be permanently empty on a SKU screen and
  // the form unsubmittable, with nothing on screen saying why.
  it("fetches the fixed product's packages without any interaction", async () => {
    vi.mocked(getProductDetail).mockResolvedValue(PACKAGES);
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    await vi.waitFor(() => {
      expect(getProductDetail).toHaveBeenCalledWith(4);
    });
  });

  // NO REQUEST FOR A CATALOGUE IT CANNOT USE. The product is fixed, so a list to
  // choose from is a round trip whose answer is discarded.
  it("does not fetch the line's product catalogue", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    expect(getLineProductOptions).not.toHaveBeenCalled();
  });

  it("sends the fixed product and no business date", async () => {
    vi.mocked(getProductDetail).mockResolvedValue(PACKAGES);
    const { mutate, mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    await vi.waitFor(() => {
      expect(getProductDetail).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "10" } });
    await pick("Machine", "Vertical Packer");
    await pick("Package / Unit", "CTN");
    await pick("Reason", "Burst seal");
    await pick("Shift", "2");

    fireEvent.click(screen.getByRole("button", { name: /add reject/i }));

    const draft = mutate.mock.calls[0]?.[0] as QualityEntryDraft;
    expect(draft.productId).toBe(4);
    expect(draft.shift).toBe(2);
    // ABSENT, not undefined: the report covers one business date and the server
    // takes it off the row, refusing a client that names a different one.
    expect("businessDate" in draft).toBe(false);
  });
});

describe("QualityEntryView — a picked SKU", () => {
  it("offers a combobox and fetches the line's catalogue", async () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView {...props({ sku: { kind: "pick", ran: [] } })} mutation={mutation} />,
    );

    expect(screen.getByLabelText("SKU").tagName).not.toBe("INPUT");
    await vi.waitFor(() => {
      expect(getLineProductOptions).toHaveBeenCalledWith(3);
    });
  });
});

describe("QualityEntryView — the shift and the date", () => {
  // PREFILLED AND DISABLED where the report names one shift; asked where it spans
  // three. Not derived from a grain, because "is the shift already known" is the
  // question this field is actually asking — a SKU day report and a line day
  // report give the same answer for different reasons.
  it("prefills and locks the shift when the report names one", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "pick", ran: [] }, fixedShift: 3 })}
        mutation={mutation}
      />,
    );

    const trigger = screen.getByLabelText("Shift");
    expect(trigger.getAttribute("data-disabled")).not.toBeNull();
    expect(trigger.textContent).toContain("3");
  });

  it("asks for the shift when the report spans three", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" }, fixedShift: null })}
        mutation={mutation}
      />,
    );

    expect(screen.getByLabelText("Shift").getAttribute("data-disabled")).toBeNull();
  });

  it("renders no date field unless the report spans more than one day", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "fixed", id: 4, name: "SKU A" } })}
        mutation={mutation}
      />,
    );

    expect(screen.queryByLabelText("Business date")).toBeNull();
  });

  it("renders one bounded to the month when it does", () => {
    const { mutation } = fakeMutation();

    renderWithQuery(
      <QualityEntryView
        {...props({ sku: { kind: "pick", ran: [] }, datePicker: { min: "2026-08-01" } })}
        mutation={mutation}
      />,
    );

    const input = screen.getByLabelText("Business date") as HTMLInputElement;
    expect(input.min).toBe("2026-08-01");
  });
});

// shadcn's Select is a listbox, not a <select>, so a value is chosen by opening
// the trigger and clicking an option.
async function pick(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.click(item);
}
