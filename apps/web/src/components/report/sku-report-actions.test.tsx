import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithQuery } from "@/test/render";
import { skuReport } from "@/test/fixtures";
import { SkuReportActions } from "@/components/report/sku-report-actions";

// WHICH ENDPOINT ANSWERS THE PANEL, and it is the whole reason this file exists.
//
// ALL FOUR ACTIVITY FETCHERS ARE STUBBED TOGETHER, deliberately. Asserting only
// that getSkuActivity ran would pass on a component that called two of them, and
// the second one would fill the panel with another subject's history — seven report
// tables, seven independent id sequences, one envelope, no warning on screen.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSkuActivity: vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", entries: [], sources: [], unattributed: 0 }),
  getLineActivity: vi.fn(),
  getShiftReportActivity: vi.fn(),
  getPeriodReportActivity: vi.fn(),
}));

const { getSkuActivity, getLineActivity, getShiftReportActivity, getPeriodReportActivity } =
  await import("@/lib/api");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkuReportActions", () => {
  it("asks the SKU endpoint, and no other subject's", async () => {
    renderWithQuery(<SkuReportActions report={skuReport({ id: 79 })} />);

    fireEvent.click(screen.getByRole("button", { name: /log activity/i }));

    await vi.waitFor(() => {
      expect(getSkuActivity).toHaveBeenCalledWith(79);
    });
    expect(getLineActivity).not.toHaveBeenCalled();
    expect(getShiftReportActivity).not.toHaveBeenCalled();
    expect(getPeriodReportActivity).not.toHaveBeenCalled();
  });

  // The query is gated on `open`, so a visit that never opens the panel pays for
  // nothing. A gated useQuery reports pending forever, which is the trap the sheet
  // reads `open` before `isPending` for.
  it("issues no request until the panel is opened", () => {
    renderWithQuery(<SkuReportActions report={skuReport()} />);

    expect(getSkuActivity).not.toHaveBeenCalled();
  });

  // NOTHING TO SIGN AND NOTHING TO DOWNLOAD. Approve needs an approval row this
  // grain cannot have; Download is still the placeholder TODOS §67 records, and one
  // live action gets a button rather than a dropdown of one.
  it("offers no Approve, no Reopen and no overflow menu", () => {
    renderWithQuery(<SkuReportActions report={skuReport()} />);

    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();
    expect(screen.queryByText(/download/i)).toBeNull();
  });
});
