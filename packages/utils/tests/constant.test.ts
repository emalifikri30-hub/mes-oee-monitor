import { describe, it, expect } from "vite-plus/test";

import {
  ALIAS_REGEX,
  COLOR_REGEX,
  CONTENT_TYPE_REGEX,
  FILENAME_REGEX,
  VERSION_REGEX,
} from "../src/constant.js";

describe("ALIAS_REGEX", () => {
  it.each(["abc", "a", "a1", "a-b-c", "lib-test"])("accepts %s", (v) => {
    expect(ALIAS_REGEX.test(v)).toBe(true);
  });

  it.each(["", "-abc", "Abc", "ABC", "a_b", "a.b"])("rejects %s", (v) => {
    expect(ALIAS_REGEX.test(v)).toBe(false);
  });
});

describe("COLOR_REGEX", () => {
  it.each(["#fff", "#ffff", "#ffffff", "#ffffffff", "#1A2b3C"])("accepts %s", (v) => {
    expect(COLOR_REGEX.test(v)).toBe(true);
  });

  it.each(["fff", "#ff", "#fffff", "#gggggg", "#1234567"])("rejects %s", (v) => {
    expect(COLOR_REGEX.test(v)).toBe(false);
  });
});

describe("FILENAME_REGEX", () => {
  it.each(["a.png", "file-name_1.txt", "1.jpg", "report.v2.csv"])("accepts %s", (v) => {
    expect(FILENAME_REGEX.test(v)).toBe(true);
  });

  it.each(["A.png", ".png", "file", "-file.png", "file."])("rejects %s", (v) => {
    expect(FILENAME_REGEX.test(v)).toBe(false);
  });
});

describe("CONTENT_TYPE_REGEX", () => {
  it.each(["image/png", "application/json", "text/vnd.abc+xml"])("accepts %s", (v) => {
    expect(CONTENT_TYPE_REGEX.test(v)).toBe(true);
  });

  it.each(["Image/png", "image", "image/", "/png", "image/PNG"])("rejects %s", (v) => {
    expect(CONTENT_TYPE_REGEX.test(v)).toBe(false);
  });
});

describe("VERSION_REGEX", () => {
  it.each(["v1.2.3", "v0.0.1", "v1.2.3-alpha", "v1.2.3-beta", "v1.2.3-rc"])("accepts %s", (v) => {
    expect(VERSION_REGEX.test(v)).toBe(true);
  });

  it.each(["1.2.3", "v1.2", "v1.2.3-gamma", "v1.2.3.4", "version"])("rejects %s", (v) => {
    expect(VERSION_REGEX.test(v)).toBe(false);
  });
});
