import { describe, expect, it } from "vite-plus/test";
import { AxiosError, AxiosHeaders } from "axios";

import { isNotFoundError } from "@/lib/route-error";

function axiosErrorWith(status?: number): AxiosError {
  const error = new AxiosError("request failed");
  if (status !== undefined) {
    error.response = {
      status,
      statusText: "",
      data: null,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    };
  }
  return error;
}

describe("isNotFoundError", () => {
  it.each([404, 400])("treats %d as a broken link", (status) => {
    expect(isNotFoundError(axiosErrorWith(status))).toBe(true);
  });

  // A server fault must reach the error boundary, not render as "does not
  // exist" — otherwise an outage looks like a deleted report.
  it.each([500, 502, 503, 401, 403, 409])("treats %d as a real failure", (status) => {
    expect(isNotFoundError(axiosErrorWith(status))).toBe(false);
  });

  // A network failure or a timeout has no response at all.
  it("treats a request that never got a response as a real failure", () => {
    expect(isNotFoundError(axiosErrorWith())).toBe(false);
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["a thrown string", "boom"],
    ["null", null],
    ["undefined", undefined],
  ])("treats %s as a real failure", (_label, error) => {
    expect(isNotFoundError(error)).toBe(false);
  });
});
