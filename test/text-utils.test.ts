import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "../src/text-utils.js";

describe("UTF-8 byte counting", () => {
  it("matches TextEncoder for ASCII, Unicode, and unpaired surrogates", () => {
    for (const value of [
      "",
      "ascii",
      "café",
      "👶",
      "a👶z",
      "\ud800",
      "\udc00",
      "\ud800x\udc00",
    ]) {
      expect(utf8ByteLength(value)).toBe(
        new TextEncoder().encode(value).byteLength,
      );
    }
  });

  it("stops once a byte limit is exceeded", () => {
    expect(utf8ByteLength("a".repeat(1_000_000), 8)).toBe(9);
    expect(utf8ByteLength("👶".repeat(1000), 8)).toBe(12);
  });
});
