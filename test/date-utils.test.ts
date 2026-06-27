import { afterEach, describe, expect, it } from "vitest";
import { getDateTime } from "../src/date-utils.js";

const ORIGINAL_FUNCTION_CALL: typeof Function.prototype.call = Reflect.get(
  Function.prototype,
  "call",
);
const ORIGINAL_DATE_GET_TIME: typeof Date.prototype.getTime = Reflect.get(
  Date.prototype,
  "getTime",
);

describe("getDateTime", () => {
  afterEach(() => {
    Function.prototype.call = ORIGINAL_FUNCTION_CALL;
    Date.prototype.getTime = ORIGINAL_DATE_GET_TIME;
  });

  it("does not depend on a later Date.prototype.getTime replacement", () => {
    const date = new Date("2030-01-02T03:04:05.006Z");
    Date.prototype.getTime = () => 0;

    expect(getDateTime(date)).toBe(1_893_553_445_006);
  });

  it("does not depend on the mutable Function.prototype.call", () => {
    const date = new Date("2030-01-02T03:04:05.006Z");
    let result: number;
    try {
      Function.prototype.call = function () {
        throw new Error("unexpected Function.prototype.call invocation");
      };
      result = getDateTime(date);
    } finally {
      Function.prototype.call = ORIGINAL_FUNCTION_CALL;
    }

    expect(result).toBe(1_893_553_445_006);
  });

  it("preserves the native Date brand check", () => {
    expect(() => getDateTime({} as Date)).toThrow(TypeError);
  });
});
