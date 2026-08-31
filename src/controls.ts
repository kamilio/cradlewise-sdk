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
const MAX_SOOTHING_LEVEL = 5;
const MAX_PERCENT = 100;
const MAX_LOCK_MINUTES = 60;
const MAX_SHADOW_BYTES = 1024 * 1024;

export interface StartSoothingOptions {
  bounceLevel: number;
  soundLevel: number;
  lockMinutes?: number;
}

export interface StartSoothingLevelsOptions {
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
  bounceIntensityLevel?: number;
  soundIntensityLevel?: number;
  maxBouncePercent?: number;
  maxSoundPercent?: number;
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

interface PendingShadowRequest {
  acceptedTopic: string;
  rejectedTopic: string;
  resolve(value: ShadowDocument): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const EMPTY_CONTROL_STATE: CradleControlState = Object.freeze({
  active: false,
  bounceOn: false,
  bounceLevel: 0,
  soundOn: false,
  soundLevel: 0,
  locked: false,
  lockMinutes: 30,
});

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
  #connectingTransport: Promise<CradlewiseMqttConnection> | undefined;
  #lifecycle = new AbortController();
  #disconnecting: Promise<void> | undefined;
  #configuration: Promise<DeviceConfiguration> | undefined;
  #shadowSubscription: Promise<void> | undefined;
  #shadowSubscriptionConnection: CradlewiseMqttConnection | undefined;
  readonly #pendingShadowRequests = new Map<string, PendingShadowRequest>();
  #lastState: CradleControlState = EMPTY_CONTROL_STATE;
  #updateQueue: Promise<void> = Promise.resolve();

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
    await this.#getConnection(this.#lifecycle.signal);
  }

  async disconnect(): Promise<void> {
    const error = new CradlewiseRealtimeError("Crib control connection closed");
    this.#lifecycle.abort(error);
    this.#lifecycle = new AbortController();
    const connection = this.#mqtt;
    const connecting = this.#connectingTransport;
    const updates = this.#updateQueue;
    this.#mqtt = undefined;
    this.#connection = undefined;
    this.#connectingTransport = undefined;
    this.#updateQueue = Promise.resolve();
    this.#resetShadowTransport(error);
    const teardown = Promise.all([
      this.#disconnecting,
      updates,
      connection && Promise.resolve().then(() => connection.endAsync()),
      connecting?.then(
        (lateConnection) => lateConnection.endAsync(),
        () => undefined,
      ),
    ]).then(() => undefined);
    this.#disconnecting = teardown;
    try {
      await teardown;
    } finally {
      if (this.#disconnecting === teardown) this.#disconnecting = undefined;
    }
  }

  async getState(): Promise<CradleControlState> {
    const signal = this.#lifecycle.signal;
    const state = controlStateFromShadow(
      await this.#shadowRequest("get", {}, signal),
    );
    assertActive(signal);
    this.#lastState = state;
    return state;
  }

  async startSoothing(
    options: StartSoothingOptions,
  ): Promise<CradleControlState> {
    if (!isPlainObject(options))
      throw new TypeError("options must be an object");
    const bounceLevel = requireLevel(options.bounceLevel, "bounceLevel");
    const soundLevel = requireLevel(options.soundLevel, "soundLevel");
    const lockMinutes = optionalLockMinutes(options.lockMinutes);
    const desired: JsonObject = {
      actuator: { on: bounceLevel > 0, amplitude: bounceLevel },
      soundSynth: {
        play: soundLevel > 0,
        volume: soundLevel,
      },
      autoModeLockOn: lockMinutes !== undefined,
      ...(lockMinutes === undefined
        ? {}
        : { autoModeLockDuration: lockMinutes }),
    };
    return this.#updateState(desired, (state) => ({
      ...state,
      active: bounceLevel > 0 || soundLevel > 0,
      bounceOn: bounceLevel > 0,
      bounceLevel,
      soundOn: soundLevel > 0,
      soundLevel,
      locked: lockMinutes !== undefined,
      ...(lockMinutes === undefined ? {} : { lockMinutes }),
    }));
  }

  async stop(): Promise<CradleControlState> {
    return this.#updateState(
      {
        actuator: { on: false },
        soundSynth: { play: false },
      },
      (state) => ({
        ...state,
        active: false,
        bounceOn: false,
        soundOn: false,
      }),
    );
  }

  async startSoothingLevels(
    options: StartSoothingLevelsOptions,
  ): Promise<CradleControlState> {
    if (!isPlainObject(options))
      throw new TypeError("options must be an object");
    const bounceLevel = requireSoothingLevel(
      options.bounceLevel,
      "bounceLevel",
    );
    const soundLevel = requireSoothingLevel(options.soundLevel, "soundLevel");
    const lockMinutes = optionalLockMinutes(options.lockMinutes);
    const desired: JsonObject = {
      ...(bounceLevel > 0
        ? { bounceLevel: bounceLevel - 1 }
        : { actuator: { on: false } }),
      ...(soundLevel > 0
        ? {
            musicLevel: soundLevel - 1,
            soundSynth: { play: true },
          }
        : { soundSynth: { play: false } }),
      autoModeLockOn: lockMinutes !== undefined,
      ...(lockMinutes === undefined
        ? {}
        : { autoModeLockDuration: lockMinutes }),
    };
    return this.#updateState(desired, (state) => ({
      ...state,
      active: bounceLevel > 0 || soundLevel > 0,
      bounceOn: bounceLevel > 0,
      soundOn: soundLevel > 0,
      bounceIntensityLevel: bounceLevel,
      soundIntensityLevel: soundLevel,
      locked: lockMinutes !== undefined,
      ...(lockMinutes === undefined ? {} : { lockMinutes }),
    }));
  }

  async setBounceLevel(level: number): Promise<CradleControlState> {
    const bounceLevel = requireLevel(level, "level");
    return this.#updateState(
      { actuator: { on: bounceLevel > 0, amplitude: bounceLevel } },
      (state) => ({
        ...state,
        active: bounceLevel > 0 || state.soundOn,
        bounceOn: bounceLevel > 0,
        bounceLevel,
      }),
    );
  }

  async setSoundLevel(level: number): Promise<CradleControlState> {
    const soundLevel = requireLevel(level, "level");
    return this.#updateState(
      { soundSynth: { play: soundLevel > 0, volume: soundLevel } },
      (state) => ({
        ...state,
        active: state.bounceOn || soundLevel > 0,
        soundOn: soundLevel > 0,
        soundLevel,
      }),
    );
  }

  async setBounceIntensityLevel(level: number): Promise<CradleControlState> {
    const bounceLevel = requireSoothingLevel(level, "level");
    return this.#updateState(
      bounceLevel > 0
        ? { bounceLevel: bounceLevel - 1 }
        : { actuator: { on: false } },
      (state) => ({
        ...state,
        active: bounceLevel > 0 || state.soundOn,
        bounceOn: bounceLevel > 0,
        bounceIntensityLevel: bounceLevel,
      }),
    );
  }

  async setSoundIntensityLevel(level: number): Promise<CradleControlState> {
    const soundLevel = requireSoothingLevel(level, "level");
    return this.#updateState(
      soundLevel > 0
        ? { musicLevel: soundLevel - 1, soundSynth: { play: true } }
        : { soundSynth: { play: false } },
      (state) => ({
        ...state,
        active: state.bounceOn || soundLevel > 0,
        soundOn: soundLevel > 0,
        soundIntensityLevel: soundLevel,
      }),
    );
  }

  async setMaxBouncePercent(percent: number): Promise<CradleControlState> {
    const maxBouncePercent = requirePercent(percent, "percent");
    return this.#updateState({ maxBounceLimit: maxBouncePercent }, (state) => ({
      ...state,
      maxBouncePercent,
    }));
  }

  async setMaxSoundPercent(percent: number): Promise<CradleControlState> {
    const maxSoundPercent = requirePercent(percent, "percent");
    return this.#updateState({ maxVolumeLimit: maxSoundPercent }, (state) => ({
      ...state,
      maxSoundPercent,
    }));
  }

  async lock(minutes = 30): Promise<CradleControlState> {
    const lockMinutes = requireLockMinutes(minutes);
    return this.#updateState(
      { autoModeLockDuration: lockMinutes, autoModeLockOn: true },
      (state) => ({ ...state, locked: true, lockMinutes }),
    );
  }

  async unlock(): Promise<CradleControlState> {
    return this.#updateState({ autoModeLockOn: false }, (state) => ({
      ...state,
      locked: false,
    }));
  }

  async #updateState(
    desired: JsonObject,
    project: (state: CradleControlState) => CradleControlState,
  ): Promise<CradleControlState> {
    const signal = this.#lifecycle.signal;
    const update = this.#updateQueue.then(async () => {
      assertActive(signal);
      await this.#shadowRequest("update", { state: { desired } }, signal);
      assertActive(signal);
      const state = project(this.#lastState);
      this.#lastState = state;
      return state;
    });
    this.#updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  async #shadowRequest(
    operation: "get" | "update",
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<ShadowDocument> {
    const connection = await this.#getConnection(signal);
    assertActive(signal);
    await withinLifecycle(signal, this.#ensureShadowSubscription(connection));
    assertActive(signal);
    const token = `cradlewise-${randomUUID()}`;
    const base = `$aws/things/${this.cradle.cradleId}/shadow/${operation}`;
    const accepted = `${base}/accepted`;
    const rejected = `${base}/rejected`;
    const response = new Promise<ShadowDocument>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingShadowRequests.delete(token);
        reject(new CradlewiseRealtimeError("Crib control request timed out"));
      }, this.#operationTimeoutMs);
      this.#pendingShadowRequests.set(token, {
        acceptedTopic: accepted,
        rejectedTopic: rejected,
        resolve,
        reject,
        timeout,
      });
    });
    void response.catch(() => undefined);
    try {
      await withinLifecycle(
        signal,
        connection.publishAsync(
          base,
          JSON.stringify({ ...body, clientToken: token }),
          { qos: 0 },
        ),
      );
      return await withinLifecycle(signal, response);
    } finally {
      const pending = this.#pendingShadowRequests.get(token);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pendingShadowRequests.delete(token);
      }
    }
  }

  async #ensureShadowSubscription(
    connection: CradlewiseMqttConnection,
  ): Promise<void> {
    if (
      this.#shadowSubscriptionConnection === connection &&
      this.#shadowSubscription
    ) {
      return this.#shadowSubscription;
    }
    if (this.#shadowSubscriptionConnection !== connection) {
      this.#resetShadowTransport(
        new CradlewiseRealtimeError("Crib control connection changed"),
      );
    }
    this.#shadowSubscriptionConnection = connection;
    connection.on("message", this.#shadowMessageListener);
    const base = `$aws/things/${this.cradle.cradleId}/shadow`;
    const topics = [
      `${base}/get/accepted`,
      `${base}/get/rejected`,
      `${base}/update/accepted`,
      `${base}/update/rejected`,
    ];
    const subscription = connection
      .subscribeAsync(topics, { qos: 0 })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.#shadowSubscriptionConnection === connection) {
          this.#resetShadowTransport(
            new CradlewiseRealtimeError(
              "Unable to subscribe to crib control responses",
              { cause: error },
            ),
          );
        }
        throw error;
      });
    this.#shadowSubscription = subscription;
    return subscription;
  }

  readonly #shadowMessageListener = (topic: string, payload: Buffer): void => {
    let parsed: ShadowDocument;
    try {
      parsed = parseShadow(payload);
    } catch (error) {
      this.#rejectPendingShadowRequests(
        error instanceof Error
          ? error
          : new CradlewiseRealtimeError("Invalid crib control response"),
      );
      return;
    }
    const token = parsed.clientToken;
    if (!token) return;
    const pending = this.#pendingShadowRequests.get(token);
    if (!pending) return;
    if (topic !== pending.acceptedTopic && topic !== pending.rejectedTopic) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pendingShadowRequests.delete(token);
    if (topic === pending.rejectedTopic) {
      pending.reject(
        new CradlewiseRealtimeError("The crib rejected the control request"),
      );
    } else {
      pending.resolve(parsed);
    }
  };

  #rejectPendingShadowRequests(error: Error): void {
    for (const pending of this.#pendingShadowRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingShadowRequests.clear();
  }

  #resetShadowTransport(error: Error): void {
    const connection = this.#shadowSubscriptionConnection;
    if (connection) {
      connection.off("message", this.#shadowMessageListener);
    }
    this.#shadowSubscription = undefined;
    this.#shadowSubscriptionConnection = undefined;
    this.#rejectPendingShadowRequests(error);
  }

  async #getConnection(signal: AbortSignal): Promise<CradlewiseMqttConnection> {
    assertActive(signal);
    if (this.#disconnecting) await withinLifecycle(signal, this.#disconnecting);
    assertActive(signal);
    if (this.#mqtt?.connected) return this.#mqtt;
    if (!this.#connection) {
      const connection = this.#openConnection(signal).finally(() => {
        if (this.#connection === connection) this.#connection = undefined;
      });
      this.#connection = connection;
    }
    return withinLifecycle(signal, this.#connection);
  }

  async #openConnection(
    signal: AbortSignal,
  ): Promise<CradlewiseMqttConnection> {
    const [configuration, credentials] = await withinLifecycle(
      signal,
      Promise.all([this.#getDeviceConfiguration(), this.auth.ensureValid()]),
    );
    assertActive(signal);
    const [cert, key] = await withinLifecycle(
      signal,
      Promise.all([
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
      ]),
    );
    assertActive(signal);
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
    let connecting: Promise<CradlewiseMqttConnection> | undefined;
    try {
      connecting = this.#mqttConnect(`mqtts://${endpoint}:8883`, options);
      this.#connectingTransport = connecting;
      const connection = await connecting;
      assertActive(signal);
      this.#mqtt = connection;
      connection.once("close", () => {
        if (this.#mqtt === connection) {
          this.#mqtt = undefined;
          this.#resetShadowTransport(
            new CradlewiseRealtimeError("Crib control connection closed"),
          );
        }
      });
      return connection;
    } catch (error) {
      assertActive(signal);
      throw new CradlewiseRealtimeError(
        "Unable to connect to the crib control service",
        {
          cause: error,
        },
      );
    } finally {
      if (this.#connectingTransport === connecting)
        this.#connectingTransport = undefined;
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

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason as Error;
}

function withinLifecycle<Value>(
  signal: AbortSignal,
  promise: Promise<Value>,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const cancel = () => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) cancel();
        else resolve(value);
      },
      (error: Error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
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
  const bounceIntensityLevel = safeSoothingLevel(reported.bounceLevel);
  const soundIntensityLevel = safeSoothingLevel(reported.musicLevel);
  const maxBouncePercent = safePercent(reported.maxBounceLimit);
  const maxSoundPercent = safePercent(reported.maxVolumeLimit);
  const locked = reported.autoModeLockOn === true;
  const lockMinutes = safeLockMinutes(reported.autoModeLockDuration);
  return {
    active: bounceOn || soundOn,
    bounceOn,
    bounceLevel,
    soundOn,
    soundLevel,
    ...(bounceIntensityLevel === undefined ? {} : { bounceIntensityLevel }),
    ...(soundIntensityLevel === undefined ? {} : { soundIntensityLevel }),
    ...(maxBouncePercent === undefined ? {} : { maxBouncePercent }),
    ...(maxSoundPercent === undefined ? {} : { maxSoundPercent }),
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

function requireSoothingLevel(value: unknown, name: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_SOOTHING_LEVEL
  ) {
    throw new RangeError(`${name} must be an integer from 0 through 5`);
  }
  return value as number;
}

function safeSoothingLevel(value: unknown): number | undefined {
  return Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < MAX_SOOTHING_LEVEL
    ? (value as number) + 1
    : undefined;
}

function requirePercent(value: unknown, name: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_PERCENT
  ) {
    throw new RangeError(`${name} must be an integer from 0 through 100`);
  }
  return value as number;
}

function safePercent(value: unknown): number | undefined {
  return Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_PERCENT
    ? (value as number)
    : undefined;
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
