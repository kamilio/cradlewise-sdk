import { describe, expect, it } from "vitest";
import {
  getArrayBufferByteLength,
  snapshotUint8Array,
} from "../src/byte-utils.js";

describe("byte utilities", () => {
  it("reads internal byte lengths despite shadowed properties", () => {
    const buffer = new ArrayBuffer(8);
    Object.defineProperty(buffer, "byteLength", { value: 0 });
    expect(getArrayBufferByteLength(buffer)).toBe(8);

    const bytes = new Uint8Array(buffer, 2, 4);
    Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(0) });
    Object.defineProperty(bytes, "byteOffset", { value: 0 });
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    const snapshot = snapshotUint8Array(bytes);
    expect(snapshot?.buffer).toBe(buffer);
    expect(snapshot?.byteOffset).toBe(2);
    expect(snapshot?.byteLength).toBe(4);
  });

  it("rejects non-buffers and invalid branded lookalikes", () => {
    expect(getArrayBufferByteLength({})).toBeUndefined();
    expect(snapshotUint8Array({})).toBeUndefined();
    expect(
      getArrayBufferByteLength(Object.create(ArrayBuffer.prototype)),
    ).toBeUndefined();
    expect(
      snapshotUint8Array(Object.create(Uint8Array.prototype)),
    ).toBeUndefined();
  });
});
