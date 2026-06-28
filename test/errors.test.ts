import { describe, expect, it } from "vitest";
import { CradlewiseApiError } from "../src/errors.js";

describe("CradlewiseApiError", () => {
  it("snapshots option getters and exposes immutable context", () => {
    const reads = new Map<string, number>();
    const cause = new Error("cause");
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      cause,
      status: 500,
      requestId: "request-1",
      responseBody: { message: "failed" },
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const error = new CradlewiseApiError("request failed", options);

    expect(Object.fromEntries(reads)).toEqual({
      cause: 1,
      status: 1,
      requestId: 1,
      responseBody: 1,
    });
    expect(error).toMatchObject({
      name: "CradlewiseApiError",
      message: "request failed",
      cause,
      status: 500,
      requestId: "request-1",
      responseBody: { message: "failed" },
    });
    expect(Reflect.set(error, "status", 200)).toBe(false);
    expect(error.status).toBe(500);
    expect(error.responseBody).toEqual({ message: "failed" });
    expect(Object.keys(error)).not.toContain("responseBody");
    expect(JSON.stringify(error)).not.toContain("failed");
  });

  it("rejects malformed options", () => {
    expect(() => new CradlewiseApiError("failed", null as never)).toThrow(
      "options must be an object",
    );
    expect(() => new CradlewiseApiError("failed", [] as never)).toThrow(
      "options must be an object",
    );
    expect(() => new CradlewiseApiError("failed", { status: 99 })).toThrow(
      "HTTP status",
    );
    expect(() => new CradlewiseApiError("failed", { status: 600 })).toThrow(
      "HTTP status",
    );
    expect(
      () => new CradlewiseApiError("failed", { requestId: "request\n2" }),
    ).toThrow("requestId");
    expect(
      () => new CradlewiseApiError("failed", { requestId: "x".repeat(8193) }),
    ).toThrow("8192 bytes");
  });
});
