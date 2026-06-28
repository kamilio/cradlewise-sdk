import { randomUUID } from "node:crypto";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import mqtt, { type IClientOptions } from "mqtt";
import type { CradlewiseAuth } from "./auth.js";
import { CradlewiseClient } from "./client.js";
import { CradlewiseRealtimeError } from "./errors.js";
import type { Cradle } from "./models.js";
import type { JsonObject } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
const DEFAULT_REGISTRATION_ID = "cradlewise-sdk-cli";
const MAX_LEVEL = 99;
const MAX_LOCK_MINUTES = 60;
const MAX_SHADOW_BYTES = 1024 * 1024;

export interface StartSoothingOptions {
  bounceLevel: number;
  soundLevel: number;
  lockMinutes?: number;
}

export interface CradleControlState {
  active: boolean;
  bounceOn: boolean;
  bounceLevel: number;
  soundOn: boolean;
  soundLevel: number;
  locked: boolean;
  lockMinutes: number;
  shadowVersion?: number;
}

export interface CradlewiseControllerOptions {
  registrationId?: string;
  operationTimeoutMs?: number;
  mqttConnect?: CradlewiseMqttConnect;
  fetch?: typeof fetch;
}

interface CradlewiseMqttConnection {
  connected: boolean;
  subscribeAsync(topics: string[], options: { qos: 0 }): Promise<unknown>;
  unsubscribeAsync(topics: string[]): Promise<unknown>;
  publishAsync(
    topic: string,
    payload: string,
    options: { qos: 0 },
  ): Promise<unknown>;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  off(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  once(event: "close", listener: () => void): this;
  endAsync(): Promise<unknown>;
}

type CradlewiseMqttConnect = (
  brokerUrl: string,
  options: object,
) => Promise<CradlewiseMqttConnection>;

interface DeviceConfiguration {
  cradleId: string;
  deviceId: string;
  s3Bucket: string;
  s3ObjectKeys: [string, string];
}

interface ShadowDocument {
  state?: {
    reported?: JsonObject;
  };
  version?: number;
  clientToken?: string;
}

export class CradlewiseController {
  readonly auth: CradlewiseAuth;
  readonly cradle: Cradle;
  readonly #client: CradlewiseClient;
  readonly #registrationId: string;
  readonly #operationTimeoutMs: number;
  readonly #mqttConnect: CradlewiseMqttConnect;
  readonly #fetch: typeof fetch;
  #mqtt: CradlewiseMqttConnection | undefined;
  #connection: Promise<CradlewiseMqttConnection> | undefined;
  #configuration: Promise<DeviceConfiguration> | undefined;

  constructor(
    auth: CradlewiseAuth,
    cradle: Cradle,
    options: CradlewiseControllerOptions = {},
  ) {
    if (!auth || typeof auth.ensureValid !== "function") {
      throw new TypeError("auth must be a CradlewiseAuth-compatible object");
    }
    if (!cradle || typeof cradle.cradleId !== "string" || !cradle.babyId) {
      throw new TypeError("cradle must include cradleId and babyId");
    }
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError("options must be an object");
    }
    this.auth = auth;
    this.cradle = cradle;
    this.#registrationId = requireRegistrationId(
      options.registrationId ?? DEFAULT_REGISTRATION_ID,
    );
    this.#operationTimeoutMs = requireTimeout(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    );
    this.#mqttConnect =
      options.mqttConnect ??
      ((brokerUrl, connectOptions) =>
        mqtt.connectAsync(brokerUrl, connectOptions as IClientOptions));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#client = new CradlewiseClient(auth, {
      allowStateChangingRequests: true,
      fetch: this.#fetch,
      requestTimeoutMs: this.#operationTimeoutMs,
    });
  }

  async connect(): Promise<void> {
    await this.#getConnection();
  }

  async disconnect(): Promise<void> {
    const connection = this.#mqtt;
    this.#mqtt = undefined;
    this.#connection = undefined;
    if (connection) await connection.endAsync();
  }

  async getState(): Promise<CradleControlState> {
    return controlStateFromShadow(await this.#getShadow());
  }

  async startSoothing(
    options: StartSoothingOptions,
  ): Promise<CradleControlState> {
    if (!isPlainObject(options))
      throw new TypeError("options must be an object");
    const bounceLevel = requireLevel(options.bounceLevel, "bounceLevel");
    const soundLevel = requireLevel(options.soundLevel, "soundLevel");
    const lockMinutes = optionalLockMinutes(options.lockMinutes);
    const shadow = await this.#getShadow();
    const reported = shadow.state?.reported ?? {};
    const soundSynth = snapshotObject(reported.soundSynth);
    const desired: JsonObject = {
      actuator: { on: bounceLevel > 0, amplitude: bounceLevel },
      soundSynth: {
        ...soundSynth,
        play: soundLevel > 0,
        volume: soundLevel,
      },
      autoModeLockOn: lockMinutes !== undefined,
      ...(lockMinutes === undefined
        ? {}
        : { autoModeLockDuration: lockMinutes }),
    };
    return this.#updateAndConfirm(
      desired,
      (state) =>
        state.bounceLevel === bounceLevel &&
        state.soundLevel === soundLevel &&
        state.bounceOn === bounceLevel > 0 &&
        state.soundOn === soundLevel > 0 &&
        state.locked === (lockMinutes !== undefined),
    );
  }

  async stop(): Promise<CradleControlState> {
    const shadow = await this.#getShadow();
    const soundSynth = snapshotObject(shadow.state?.reported?.soundSynth);
    return this.#updateAndConfirm(
      {
        actuator: { on: false },
        soundSynth: { ...soundSynth, play: false },
      },
      (state) => !state.bounceOn && !state.soundOn,
    );
  }

  async setBounceLevel(level: number): Promise<CradleControlState> {
    const bounceLevel = requireLevel(level, "level");
    return this.#updateAndConfirm(
      { actuator: { on: bounceLevel > 0, amplitude: bounceLevel } },
      (state) =>
        state.bounceLevel === bounceLevel && state.bounceOn === level > 0,
    );
  }

  async setSoundLevel(level: number): Promise<CradleControlState> {
    const soundLevel = requireLevel(level, "level");
    const shadow = await this.#getShadow();
    const soundSynth = snapshotObject(shadow.state?.reported?.soundSynth);
    return this.#updateAndConfirm(
      {
        soundSynth: {
          ...soundSynth,
          play: soundLevel > 0,
          volume: soundLevel,
        },
      },
      (state) => state.soundLevel === soundLevel && state.soundOn === level > 0,
    );
  }

  async lock(minutes = 30): Promise<CradleControlState> {
    const lockMinutes = requireLockMinutes(minutes);
    return this.#updateAndConfirm(
      { autoModeLockDuration: lockMinutes, autoModeLockOn: true },
      (state) => state.locked && state.lockMinutes === lockMinutes,
    );
  }

  async unlock(): Promise<CradleControlState> {
    return this.#updateAndConfirm(
      { autoModeLockOn: false },
      (state) => !state.locked,
    );
  }

  async #updateAndConfirm(
    desired: JsonObject,
    matches: (state: CradleControlState) => boolean,
  ): Promise<CradleControlState> {
    await this.#shadowRequest("update", { state: { desired } });
    const deadline = Date.now() + this.#operationTimeoutMs;
    let state = await this.getState();
    while (!matches(state)) {
      if (Date.now() >= deadline) {
        throw new CradlewiseRealtimeError(
          "The crib did not confirm the requested control change",
        );
      }
      await delay(250);
      state = await this.getState();
    }
    return state;
  }

  async #getShadow(): Promise<ShadowDocument> {
    return this.#shadowRequest("get", {});
  }

  async #shadowRequest(
    operation: "get" | "update",
    body: JsonObject,
  ): Promise<ShadowDocument> {
    const connection = await this.#getConnection();
    const token = `cradlewise-${randomUUID()}`;
    const base = `$aws/things/${this.cradle.cradleId}/shadow/${operation}`;
    const accepted = `${base}/accepted`;
    const rejected = `${base}/rejected`;
    await connection.subscribeAsync([accepted, rejected], { qos: 0 });
    try {
      const response = new Promise<ShadowDocument>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new CradlewiseRealtimeError("Crib control request timed out"));
        }, this.#operationTimeoutMs);
        const onMessage = (topic: string, payload: Buffer): void => {
          if (topic !== accepted && topic !== rejected) return;
          let parsed: ShadowDocument;
          try {
            parsed = parseShadow(payload);
          } catch (error) {
            cleanup();
            reject(
              error instanceof Error
                ? error
                : new CradlewiseRealtimeError("Invalid crib control response"),
            );
            return;
          }
          if (parsed.clientToken !== token) return;
          cleanup();
          if (topic === rejected) {
            reject(
              new CradlewiseRealtimeError(
                "The crib rejected the control request",
              ),
            );
          } else {
            resolve(parsed);
          }
        };
        const cleanup = (): void => {
          clearTimeout(timeout);
          connection.off("message", onMessage);
        };
        connection.on("message", onMessage);
      });
      await connection.publishAsync(
        base,
        JSON.stringify({ ...body, clientToken: token }),
        { qos: 0 },
      );
      return await response;
    } finally {
      await connection
        .unsubscribeAsync([accepted, rejected])
        .catch(() => undefined);
    }
  }

  async #getConnection(): Promise<CradlewiseMqttConnection> {
    if (this.#mqtt?.connected) return this.#mqtt;
    this.#connection ??= this.#openConnection().finally(() => {
      this.#connection = undefined;
    });
    return this.#connection;
  }

  async #openConnection(): Promise<CradlewiseMqttConnection> {
    const [configuration, credentials] = await Promise.all([
      this.#getDeviceConfiguration(),
      this.auth.ensureValid(),
    ]);
    const [cert, key] = await Promise.all([
      downloadS3Object(
        configuration.s3Bucket,
        configuration.s3ObjectKeys[0],
        this.auth.appConfig.cognitoRegion,
        credentials.aws,
        this.#fetch,
      ),
      downloadS3Object(
        configuration.s3Bucket,
        configuration.s3ObjectKeys[1],
        this.auth.appConfig.cognitoRegion,
        credentials.aws,
        this.#fetch,
      ),
    ]);
    const endpoint = this.auth.appConfig.iotEndpoint;
    if (!endpoint) {
      throw new CradlewiseRealtimeError("Cradlewise IoT is not configured");
    }
    const options: IClientOptions = {
      clientId: configuration.deviceId,
      cert,
      key,
      clean: false,
      connectTimeout: this.#operationTimeoutMs,
      reconnectPeriod: 0,
      protocolVersion: 4,
      rejectUnauthorized: true,
    };
    try {
      const connection = await this.#mqttConnect(
        `mqtts://${endpoint}:8883`,
        options,
      );
      this.#mqtt = connection;
      connection.once("close", () => {
        if (this.#mqtt === connection) this.#mqtt = undefined;
      });
      return connection;
    } catch (error) {
      throw new CradlewiseRealtimeError(
        "Unable to connect to the crib control service",
        {
          cause: error,
        },
      );
    }
  }

  async #getDeviceConfiguration(): Promise<DeviceConfiguration> {
    this.#configuration ??= this.#provisionDeviceConfiguration().catch(
      (error) => {
        this.#configuration = undefined;
        throw error;
      },
    );
    return this.#configuration;
  }

  async #provisionDeviceConfiguration(): Promise<DeviceConfiguration> {
    const result = await this.#client.request<unknown>(
      "POST",
      "/cradles/pairedUsers/v3",
      {
        body: {
          email_id: this.auth.email,
          baby_id: Number(this.cradle.babyId),
          fcm_token: this.#registrationId,
          device: {
            registration_date: "",
            app_version: `cradlewise-sdk/${PACKAGE_VERSION}`,
            country: "US",
            os: "android",
            device_name: "cradlewise-sdk",
            os_version: process.versions.node,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            type: "phone",
            resolution: "{0,0}",
          },
        },
      },
    );
    return parseDeviceConfiguration(result, this.cradle.cradleId);
  }
}

function parseDeviceConfiguration(
  value: unknown,
  cradleId: string,
): DeviceConfiguration {
  if (!isPlainObject(value) || !isPlainObject(value.device_config)) {
    throw new CradlewiseRealtimeError(
      "Cradlewise returned an invalid control configuration",
    );
  }
  const config = value.device_config;
  if (
    config.cradle_id !== cradleId ||
    typeof config.device_id !== "string" ||
    typeof config.s3_bucket !== "string" ||
    !isTwoNonemptyStrings(config.s3_object_keys)
  ) {
    throw new CradlewiseRealtimeError(
      "Cradlewise returned an invalid control configuration",
    );
  }
  const deviceId = config.device_id;
  const s3Bucket = config.s3_bucket;
  const [certificateKey = "", privateKey = ""] = config.s3_object_keys;
  return {
    cradleId,
    deviceId,
    s3Bucket,
    s3ObjectKeys: [certificateKey, privateKey],
  };
}

async function downloadS3Object(
  bucket: string,
  objectKey: string,
  region: string,
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  },
  fetchImplementation: typeof fetch,
): Promise<string> {
  const hostname = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  const signer = new SignatureV4({
    credentials,
    region,
    service: "s3",
    sha256: Sha256,
  });
  const request = await signer.sign(
    new HttpRequest({
      protocol: "https:",
      hostname,
      method: "GET",
      path,
      headers: { host: hostname },
    }),
  );
  const response = await fetchImplementation(`https://${hostname}${path}`, {
    headers: request.headers,
    redirect: "error",
    signal: AbortSignal.timeout(DEFAULT_OPERATION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new CradlewiseRealtimeError(
      "Unable to download crib control credentials",
    );
  }
  const text = await response.text();
  if (text.length === 0 || text.length > 64 * 1024) {
    throw new CradlewiseRealtimeError(
      "Cradlewise returned invalid control credentials",
    );
  }
  return text;
}

function controlStateFromShadow(shadow: ShadowDocument): CradleControlState {
  const reported = shadow.state?.reported ?? {};
  const actuator = snapshotObject(reported.actuator);
  const soundSynth = snapshotObject(reported.soundSynth);
  const bounceOn = actuator.on === true;
  const soundOn = soundSynth.play === true;
  const bounceLevel = safeLevel(actuator.amplitude);
  const soundLevel = safeLevel(soundSynth.volume);
  const locked = reported.autoModeLockOn === true;
  const lockMinutes = safeLockMinutes(reported.autoModeLockDuration);
  return {
    active: bounceOn || soundOn,
    bounceOn,
    bounceLevel,
    soundOn,
    soundLevel,
    locked,
    lockMinutes,
    ...(Number.isSafeInteger(shadow.version)
      ? { shadowVersion: shadow.version }
      : {}),
  };
}

function parseShadow(payload: Buffer): ShadowDocument {
  if (payload.byteLength === 0 || payload.byteLength > MAX_SHADOW_BYTES) {
    throw new CradlewiseRealtimeError(
      "Cradlewise returned an invalid shadow response",
    );
  }
  try {
    const value: unknown = JSON.parse(payload.toString("utf8"));
    if (!isPlainObject(value)) throw new Error("invalid");
    return value;
  } catch (error) {
    throw new CradlewiseRealtimeError(
      "Cradlewise returned an invalid shadow response",
      {
        cause: error,
      },
    );
  }
}

function snapshotObject(value: unknown): JsonObject {
  return isPlainObject(value) ? { ...value } : {};
}

function requireLevel(value: unknown, name: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_LEVEL
  ) {
    throw new RangeError(`${name} must be an integer from 0 through 99`);
  }
  return value as number;
}

function safeLevel(value: unknown): number {
  return Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_LEVEL
    ? (value as number)
    : 0;
}

function optionalLockMinutes(value: unknown): number | undefined {
  return value === undefined ? undefined : requireLockMinutes(value);
}

function requireLockMinutes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LOCK_MINUTES
  ) {
    throw new RangeError("lockMinutes must be an integer from 1 through 60");
  }
  return value;
}

function safeLockMinutes(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LOCK_MINUTES
    ? value
    : 30;
}

function requireRegistrationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(
      "registrationId must be a control-free string from 1 through 256 characters",
    );
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function requireTimeout(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1_000 ||
    (value as number) > 120_000
  ) {
    throw new RangeError(
      "operationTimeoutMs must be an integer from 1000 through 120000",
    );
  }
  return value as number;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTwoNonemptyStrings(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    value[0].length > 0 &&
    typeof value[1] === "string" &&
    value[1].length > 0
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
