const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
type InternalGetter = (...arguments_: unknown[]) => unknown;
const typedArrayBufferGetter = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer") as object,
  "get",
) as InternalGetter;
const typedArrayByteOffsetGetter = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset") as object,
  "get",
) as InternalGetter;
const typedArrayByteLengthGetter = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") as object,
  "get",
) as InternalGetter;
const arrayBufferByteLengthGetter = Reflect.get(
  Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  ) as object,
  "get",
) as InternalGetter;

export function getArrayBufferByteLength(value: unknown): number | undefined {
  if (!(value instanceof ArrayBuffer)) {
    return undefined;
  }
  try {
    const byteLength: unknown = Reflect.apply(
      arrayBufferByteLengthGetter,
      value,
      [],
    );
    return typeof byteLength === "number" &&
      Number.isSafeInteger(byteLength) &&
      byteLength >= 0
      ? byteLength
      : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotUint8Array(value: unknown): Uint8Array | undefined {
  if (!(value instanceof Uint8Array)) {
    return undefined;
  }
  try {
    const buffer: unknown = Reflect.apply(typedArrayBufferGetter, value, []);
    const byteOffset: unknown = Reflect.apply(
      typedArrayByteOffsetGetter,
      value,
      [],
    );
    const byteLength: unknown = Reflect.apply(
      typedArrayByteLengthGetter,
      value,
      [],
    );
    if (
      typeof byteOffset !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0
    ) {
      return undefined;
    }
    return new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
  } catch {
    return undefined;
  }
}
