import { utf8ByteLength } from "./text-utils.js";

export class CradlewiseError extends Error {
  override readonly name: string = "CradlewiseError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class CradlewiseConfigError extends CradlewiseError {
  override readonly name = "CradlewiseConfigError";
}

export class CradlewiseAuthError extends CradlewiseError {
  override readonly name = "CradlewiseAuthError";
}

export interface CradlewiseApiErrorOptions extends ErrorOptions {
  status?: number | undefined;
  requestId?: string | undefined;
  responseBody?: unknown;
}

export class CradlewiseApiError extends CradlewiseError {
  override readonly name = "CradlewiseApiError";
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly responseBody: unknown;

  constructor(message: string, options: CradlewiseApiErrorOptions = {}) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError("options must be an object");
    }
    const cause = options.cause;
    const status = options.status;
    const requestId = options.requestId;
    const responseBody = options.responseBody;
    if (
      status !== undefined &&
      (!Number.isInteger(status) || status < 100 || status > 599)
    ) {
      throw new RangeError(
        "status must be an HTTP status from 100 through 599",
      );
    }
    if (
      requestId !== undefined &&
      (typeof requestId !== "string" ||
        requestId.length === 0 ||
        utf8ByteLength(requestId, 8192) > 8192 ||
        hasControlCharacter(requestId))
    ) {
      throw new TypeError(
        "requestId must be a nonempty control-free string no longer than 8192 bytes",
      );
    }
    super(message, cause === undefined ? undefined : { cause });
    this.status = status;
    this.requestId = requestId;
    this.responseBody = responseBody;
    for (const key of ["status", "requestId"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    Object.defineProperty(this, "responseBody", {
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export class CradlewiseRealtimeError extends CradlewiseError {
  override readonly name = "CradlewiseRealtimeError";
}
