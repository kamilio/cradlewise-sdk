import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { CradlewiseAuth } from "./auth.js";
import { getArrayBufferByteLength, snapshotUint8Array } from "./byte-utils.js";
import type { CradlewiseClient } from "./client.js";
import { isAwsIotEndpointForRegion } from "./config.js";
import { CradlewiseRealtimeError } from "./errors.js";
import { cloneCradleState } from "./models.js";
import { utf8ByteLength } from "./text-utils.js";
import type {
  CradleState,
  CradlewiseAwsCredentials,
  StateUpdateHandler,
} from "./types.js";

const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_CRADLE_IDS = 100;
const MAX_MESSAGE_DEPTH = 100;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGE_VALUES = 100_000;

export interface CradlewiseRealtimeOptions {
  auth: CradlewiseAuth;
  cradleIds: Iterable<string> & object;
  client?: CradlewiseClient;
  iotEndpoint?: string;
  onStateUpdate?: StateUpdateHandler;
  clientId?: string;
  credentialRefreshWindowMs?: number;
  operationTimeoutMs?: number;
  allowLegacyIamAuthentication?: boolean;
}

export interface CradlewiseRealtimeEventMap {
  connect: [];
  interrupt: [error: Error];
  resume: [returnCode: number, sessionPresent: boolean];
  disconnect: [];
  error: [error: Error];
  state: [cradleId: string, state: CradleState, topic: string];
  messageError: [error: unknown, context?: string];
}

interface MqttConnection {
  on(event: "interrupt", listener: (error: Error) => void): void;
  on(
    event: "resume",
    listener: (returnCode: number, sessionPresent: boolean) => void,
  ): void;
  on(event: "disconnect", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  subscribe(
    topic: string,
    qos: unknown,
    callback: (topic: string, payload: unknown) => void,
  ): Promise<unknown>;
  unsubscribe(topic: string): Promise<unknown>;
  publish(topic: string, payload: string, qos: unknown): Promise<unknown>;
}

export class CradlewiseRealtime extends EventEmitter<CradlewiseRealtimeEventMap> {
  readonly auth: CradlewiseAuth;
  readonly #cradleIds: Set<string>;
  readonly #client: CradlewiseClient | undefined;
  readonly #cognitoRegion: string;
  readonly #iotEndpoint: string | undefined;
  readonly #onStateUpdate: StateUpdateHandler | undefined;
  readonly #clientId: string;
  readonly #credentialRefreshWindowMs: number;
  readonly #operationTimeoutMs: number;
  readonly #allowLegacyIamAuthentication: boolean;
  readonly #ensureValid: (minimumValidityMs: number) => Promise<unknown>;
  #connection: MqttConnection | undefined;
  #connecting: Promise<void> | undefined;
  #disconnecting: Promise<void> | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #connected = false;
  #disconnectRequested = false;
  #lifecycleGeneration = Symbol();

  constructor(options: CradlewiseRealtimeOptions) {
    super();
    if (!isPlainObject(options)) {
      throw new TypeError("options must be a plain object");
    }
    const auth = options.auth;
    const cradleIds = options.cradleIds;
    const allowLegacyIamAuthentication = options.allowLegacyIamAuthentication;
    const iotEndpoint = options.iotEndpoint;
    const client = options.client;
    const onStateUpdate = options.onStateUpdate;
    const clientId = options.clientId;
    const credentialRefreshWindowMs = options.credentialRefreshWindowMs;
    const operationTimeoutMs = options.operationTimeoutMs;
    const authSnapshot = readRealtimeAuthSnapshot(auth);
    const cradleIdIterable = snapshotStringIterable(cradleIds);
    if (!authSnapshot) {
      throw new TypeError("auth must be a CradlewiseAuth-compatible object");
    }
    if (!cradleIdIterable) {
      throw new TypeError("cradleIds must be a nonstring iterable");
    }
    if (
      allowLegacyIamAuthentication !== undefined &&
      typeof allowLegacyIamAuthentication !== "boolean"
    ) {
      throw new TypeError("allowLegacyIamAuthentication must be a boolean");
    }
    if (iotEndpoint !== undefined && typeof iotEndpoint !== "string") {
      throw new TypeError("iotEndpoint must be a string");
    }
    if (
      client !== undefined &&
      (!isObjectRecord(client) || !(client.cradles instanceof Map))
    ) {
      throw new TypeError("client must expose a cradles Map");
    }
    this.auth = auth;
    Object.defineProperty(this, "auth", {
      configurable: false,
      enumerable: true,
      writable: false,
    });
    this.#cradleIds = readCradleIds(cradleIdIterable);
    this.#client = client;
    this.#ensureValid = authSnapshot.ensureValid;
    this.#cognitoRegion = authSnapshot.cognitoRegion;
    this.#iotEndpoint = iotEndpoint ?? authSnapshot.iotEndpoint;
    if (
      this.#iotEndpoint !== undefined &&
      !isAwsIotEndpointForRegion(this.#iotEndpoint, this.#cognitoRegion)
    ) {
      throw new CradlewiseRealtimeError(
        "iotEndpoint must be an AWS IoT ATS hostname in the configured Cognito region",
      );
    }
    this.#onStateUpdate = onStateUpdate;
    if (onStateUpdate !== undefined && typeof onStateUpdate !== "function") {
      throw new TypeError("onStateUpdate must be a function");
    }
    this.#clientId = requireClientId(
      clientId ??
        `ha-cradlewise-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    );
    this.#credentialRefreshWindowMs = credentialRefreshWindowMs ?? 5 * 60_000;
    this.#operationTimeoutMs = operationTimeoutMs ?? 30_000;
    this.#allowLegacyIamAuthentication = allowLegacyIamAuthentication ?? false;
    if (
      !Number.isSafeInteger(this.#credentialRefreshWindowMs) ||
      this.#credentialRefreshWindowMs < 0 ||
      this.#credentialRefreshWindowMs > 2_147_483_647
    ) {
      throw new RangeError(
        "credentialRefreshWindowMs must be a nonnegative integer no greater than 2147483647",
      );
    }
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs <= 0 ||
      this.#operationTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError(
        "operationTimeoutMs must be a positive integer no greater than 2147483647",
      );
    }
  }

  get connected(): boolean {
    return this.#connected;
  }

  get cradleIds(): ReadonlySet<string> {
    return new Set(this.#cradleIds);
  }

  async connect(): Promise<void> {
    const generation = Symbol();
    this.#lifecycleGeneration = generation;
    return this.#connectForGeneration(generation);
  }

  async #connectForGeneration(generation: symbol): Promise<void> {
    if (this.#disconnecting) await this.#disconnecting;
    if (generation !== this.#lifecycleGeneration) return;
    if (this.#connected) return;
    if (this.#connecting) return this.#connecting;
    if (!this.#allowLegacyIamAuthentication) {
      throw new CradlewiseRealtimeError(
        "Current Cradlewise realtime requires per-device certificate provisioning, which this read-only package does not perform. The legacy IAM WebSocket transport is disabled by default.",
      );
    }
    if (!this.#iotEndpoint) {
      throw new CradlewiseRealtimeError(
        "No AWS IoT endpoint is configured. Refresh app config or pass iotEndpoint.",
      );
    }
    if (this.#connection) {
      await this.#beginDisconnect();
      if (generation !== this.#lifecycleGeneration) return;
    }
    this.#disconnectRequested = false;
    this.#connecting ??= this.#performConnect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async addCradle(cradleId: string): Promise<void> {
    requireCradleId(cradleId);
    if (this.#disconnecting) await this.#disconnecting;
    if (this.#cradleIds.has(cradleId)) return;
    if (this.#cradleIds.size >= MAX_CRADLE_IDS) {
      throw new RangeError("Realtime supports at most 100 crib IDs");
    }
    this.#cradleIds.add(cradleId);
    if (this.#connected) {
      const sdk = await import("aws-iot-device-sdk-v2");
      const connection = this.#connection;
      try {
        await this.#subscribe(cradleId, sdk.mqtt.QoS.AtLeastOnce, connection);
      } catch (error) {
        if (
          this.#disconnectRequested ||
          !this.#connected ||
          this.#connection !== connection
        ) {
          return;
        }
        this.#cradleIds.delete(cradleId);
        let recoveryFailure: { reason: unknown } | undefined;
        if (error instanceof AggregateError) {
          try {
            await this.reconnect();
          } catch (reconnectError) {
            recoveryFailure = { reason: reconnectError };
          }
        }
        throw new CradlewiseRealtimeError(
          `Unable to subscribe to crib ${cradleId}`,
          {
            cause: recoveryFailure
              ? new AggregateError([error, recoveryFailure.reason])
              : error,
          },
        );
      }
    }
  }

  async removeCradle(cradleId: string): Promise<void> {
    requireCradleId(cradleId);
    if (this.#disconnecting) await this.#disconnecting;
    if (!this.#cradleIds.delete(cradleId) || !this.#connected) return;
    const failures = await this.#unsubscribe(topicsForCradle(cradleId));
    if (failures.length === 0 && !this.#cradleIds.has(cradleId)) return;
    if (failures.length === 0) {
      try {
        await this.reconnect();
        return;
      } catch (reconnectError) {
        throw new CradlewiseRealtimeError(
          `Unable to restore concurrently re-added crib ${cradleId}`,
          { cause: reconnectError },
        );
      }
    }
    try {
      await this.reconnect();
    } catch (reconnectError) {
      throw new CradlewiseRealtimeError(
        `Unable to fully remove crib ${cradleId} from realtime updates`,
        {
          cause: new AggregateError([...failures, reconnectError]),
        },
      );
    }
  }

  async reconnect(): Promise<void> {
    const generation = Symbol();
    this.#lifecycleGeneration = generation;
    await this.#beginDisconnect();
    if (generation !== this.#lifecycleGeneration) return;
    await this.#connectForGeneration(generation);
  }

  async disconnect(): Promise<void> {
    this.#lifecycleGeneration = Symbol();
    return this.#beginDisconnect();
  }

  async #beginDisconnect(): Promise<void> {
    this.#disconnectRequested = true;
    this.#disconnecting ??= this.#performDisconnect().finally(() => {
      this.#disconnecting = undefined;
    });
    return this.#disconnecting;
  }

  async #performDisconnect(): Promise<void> {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    if (this.#connecting) {
      try {
        await this.#connecting;
      } catch {
        await this.#disconnectCurrent();
        return;
      }
    }
    await this.#disconnectCurrent();
  }

  async #performConnect(): Promise<void> {
    let connection: MqttConnection | undefined;
    let initialized = false;
    let interrupted = false;
    let recovering = false;
    const connectionSignal = AbortSignal.timeout(this.#operationTimeoutMs);
    try {
      const iotEndpoint = this.#iotEndpoint;
      if (!iotEndpoint) {
        throw new CradlewiseRealtimeError("No AWS IoT endpoint is configured");
      }
      const sdk = await this.#withOperationDeadline(
        import("aws-iot-device-sdk-v2"),
        connectionSignal,
      );
      throwIfAborted(connectionSignal);
      const credentialsResult = await this.#withOperationDeadline(
        this.#ensureValid(this.#credentialRefreshWindowMs),
        connectionSignal,
      );
      const credentials = readRealtimeCredentials(credentialsResult);
      if (!credentials) {
        throw new CradlewiseRealtimeError(
          "Realtime authentication returned invalid AWS credentials",
        );
      }
      this.#validateCredentialExpiration(credentials.expiration);
      if (this.#disconnectRequested) return;
      const provider = sdk.auth.AwsCredentialsProvider.newStatic(
        credentials.accessKeyId,
        credentials.secretAccessKey,
        credentials.sessionToken,
      );
      const builder =
        sdk.iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
          region: this.#cognitoRegion,
          credentials_provider: provider,
        });
      builder.with_clean_session(true);
      builder.with_client_id(this.#clientId);
      builder.with_endpoint(iotEndpoint);
      builder.with_keep_alive_seconds(30);

      const mqttClient = new sdk.mqtt.MqttClient();
      connection = mqttClient.new_connection(builder.build());
      const activeConnection = connection;
      this.#connection = activeConnection;
      activeConnection.on("interrupt", (error: Error) => {
        if (this.#connection !== activeConnection) return;
        interrupted = true;
        this.#connected = false;
        this.#emitEvent("interrupt", error);
      });
      activeConnection.on(
        "resume",
        (returnCode: number, sessionPresent: boolean) => {
          if (this.#connection !== activeConnection) return;
          interrupted = false;
          this.#emitEvent("resume", returnCode, sessionPresent);
          if (!initialized) return;
          if (sessionPresent) {
            this.#connected = true;
          } else if (!recovering) {
            this.#connected = false;
            recovering = true;
            void this.#recoverSubscriptions(
              sdk.mqtt.QoS.AtLeastOnce,
              activeConnection,
            ).finally(() => {
              recovering = false;
            });
          }
        },
      );
      activeConnection.on("disconnect", () => {
        if (this.#connection !== activeConnection) return;
        if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = undefined;
        this.#connection = undefined;
        this.#connected = false;
        this.#emitEvent("disconnect");
      });
      activeConnection.on("error", (error: Error) => {
        if (this.#connection !== activeConnection) return;
        this.#emitError(error);
      });

      throwIfAborted(connectionSignal);
      await this.#withOperationDeadline(
        activeConnection.connect(),
        connectionSignal,
        () => this.#disconnectLateConnection(activeConnection),
      );
      if (this.#disconnectRequested) {
        await this.#disconnectCurrent();
        return;
      }
      if (interrupted) {
        throw new CradlewiseRealtimeError(
          "Realtime connection was interrupted during initialization",
        );
      }
      await this.#subscribeAll(
        sdk.mqtt.QoS.AtLeastOnce,
        activeConnection,
        connectionSignal,
      );
      if (this.#disconnectRequested) {
        await this.#disconnectCurrent();
        return;
      }
      if (interrupted) {
        throw new CradlewiseRealtimeError(
          "Realtime connection was interrupted during initialization",
        );
      }
      initialized = true;
      this.#connected = true;
      this.#scheduleCredentialRefresh(credentials.expiration);
      this.#emitEvent("connect");
    } catch (error) {
      if (this.#disconnectRequested) {
        if (this.#connection === connection) await this.#disconnectCurrent();
        return;
      }
      if (this.#connection === connection) await this.#disconnectCurrent();
      throw new CradlewiseRealtimeError(
        "Unable to connect to Cradlewise realtime updates",
        {
          cause: error,
        },
      );
    }
  }

  async #disconnectCurrent(): Promise<void> {
    const connection = this.#connection;
    const wasConnected = this.#connected;
    this.#connection = undefined;
    this.#connected = false;
    if (!connection) return;
    try {
      await this.#withOperationDeadline(connection.disconnect());
    } catch (error) {
      this.#emitError(error);
    } finally {
      if (wasConnected) this.#emitEvent("disconnect");
    }
  }

  async #subscribeAll(
    qos: unknown,
    connection = this.#connection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!connection) {
      throw new CradlewiseRealtimeError(
        "Realtime connection is not initialized",
      );
    }
    const subscribedCradleIds = new Set<string>();
    while (true) {
      for (const cradleId of this.#cradleIds) {
        if (subscribedCradleIds.has(cradleId)) continue;
        try {
          await this.#subscribe(cradleId, qos, connection, signal);
          subscribedCradleIds.add(cradleId);
        } catch (error) {
          if (
            !this.#cradleIds.has(cradleId) &&
            !(error instanceof AggregateError)
          ) {
            continue;
          }
          throw error;
        }
      }

      const removedCradleIds = [...subscribedCradleIds].filter(
        (cradleId) => !this.#cradleIds.has(cradleId),
      );
      for (const cradleId of removedCradleIds) {
        const failures = await this.#unsubscribe(
          topicsForCradle(cradleId),
          connection,
        );
        if (failures.length > 0) throw new AggregateError(failures);
        subscribedCradleIds.delete(cradleId);
      }

      if (
        subscribedCradleIds.size === this.#cradleIds.size &&
        [...this.#cradleIds].every((cradleId) =>
          subscribedCradleIds.has(cradleId),
        )
      ) {
        return;
      }
    }
  }

  async #recoverSubscriptions(
    qos: unknown,
    connection: MqttConnection,
  ): Promise<void> {
    try {
      await this.#subscribeAll(qos, connection);
      if (this.#connection === connection && !this.#disconnectRequested) {
        this.#connected = true;
      }
    } catch (error) {
      if (this.#connection !== connection) return;
      try {
        await this.reconnect();
      } catch (reconnectError) {
        this.#emitError(new AggregateError([error, reconnectError]));
      }
    }
  }

  async #subscribe(
    cradleId: string,
    qos: unknown,
    connection = this.#connection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!connection || this.#connection !== connection) {
      throw new CradlewiseRealtimeError(
        "Realtime connection is not initialized",
      );
    }
    const onMessage = (topic: string, payload: unknown) => {
      if (this.#connection !== connection || !this.#cradleIds.has(cradleId)) {
        return;
      }
      let state: CradleState;
      try {
        const bytes = readMqttPayload(payload);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        validateMessageJsonStructure(text);
        const parsed: unknown = JSON.parse(text);
        state = cloneCradleState(extractState(parsed));
        this.#client?.cradles.get(cradleId)?.updateState(state);
      } catch (error) {
        this.#emitMessageError(error, topic);
        return;
      }
      try {
        this.#onStateUpdate?.(cradleId, cloneCradleState(state));
      } catch (error) {
        this.#emitMessageError(error, topic);
      }
      this.#emitStateEvent(cradleId, state, topic);
    };
    const topics = topicsForCradle(cradleId);
    const subscribed: string[] = [];
    try {
      for (const topic of topics) {
        if (signal) throwIfAborted(signal);
        if (
          this.#connection !== connection ||
          this.#disconnectRequested ||
          !this.#cradleIds.has(cradleId)
        ) {
          throw new CradlewiseRealtimeError(
            "Realtime connection changed during subscription",
          );
        }
        await this.#withOperationDeadline(
          connection.subscribe(topic, qos, onMessage),
          signal,
          () => this.#unsubscribeLateSubscription(topic, connection),
        );
        subscribed.push(topic);
      }
      if (this.#connection !== connection) {
        throw new CradlewiseRealtimeError(
          "Realtime connection changed during subscription",
        );
      }
      if (this.#disconnectRequested || !this.#cradleIds.has(cradleId)) {
        throw new CradlewiseRealtimeError(
          "Realtime subscription is no longer requested",
        );
      }
      if (signal) throwIfAborted(signal);
      await this.#withOperationDeadline(
        connection.publish(
          `$aws/things/${cradleId}/shadow/get`,
          JSON.stringify({}),
          qos,
        ),
        signal,
      );
      if (this.#disconnectRequested || !this.#cradleIds.has(cradleId)) {
        throw new CradlewiseRealtimeError(
          "Realtime subscription is no longer requested",
        );
      }
    } catch (error) {
      const rollbackFailures = await this.#unsubscribe(subscribed, connection);
      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures]);
      }
      throw error;
    }
  }

  async #unsubscribe(
    topics: Iterable<string>,
    connection = this.#connection,
  ): Promise<unknown[]> {
    if (!connection) return [];
    const results = await Promise.allSettled(
      Array.from(topics, (topic) =>
        this.#withOperationDeadline(connection.unsubscribe(topic)),
      ),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        failures.push(reason);
      }
    }
    return failures;
  }

  #scheduleCredentialRefresh(expiration: Date): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    const expirationTime = this.#validateCredentialExpiration(expiration);
    const delay = Math.min(
      2_147_483_647,
      expirationTime - Date.now() - this.#credentialRefreshWindowMs,
    );
    this.#refreshTimer = setTimeout(() => {
      void this.reconnect().catch((error) => this.#emitError(error));
    }, delay);
    this.#refreshTimer.unref();
  }

  #validateCredentialExpiration(expiration: Date): number {
    const expirationTime = expiration.getTime();
    if (!Number.isFinite(expirationTime)) {
      throw new CradlewiseRealtimeError(
        "Realtime credentials have an invalid expiration date",
      );
    }
    if (expirationTime <= Date.now()) {
      throw new CradlewiseRealtimeError(
        "Realtime credentials are already expired",
      );
    }
    if (expirationTime <= Date.now() + this.#credentialRefreshWindowMs) {
      throw new CradlewiseRealtimeError(
        "Realtime credentials have insufficient remaining validity",
      );
    }
    return expirationTime;
  }

  #withOperationDeadline<T>(
    operation: PromiseLike<T>,
    signal = AbortSignal.timeout(this.#operationTimeoutMs),
    onLateValue?: (value: T) => void,
  ): Promise<T> {
    return raceWithAbort(operation, signal, onLateValue);
  }

  #disconnectLateConnection(connection: MqttConnection): void {
    try {
      void this.#withOperationDeadline(connection.disconnect()).catch((error) =>
        this.#emitError(error),
      );
    } catch (error) {
      this.#emitError(error);
    }
  }

  #unsubscribeLateSubscription(
    topic: string,
    connection: MqttConnection,
  ): void {
    try {
      void this.#withOperationDeadline(connection.unsubscribe(topic)).catch(
        (error) => this.#emitError(error),
      );
    } catch (error) {
      this.#emitError(error);
    }
  }

  #emitError(error: unknown): void {
    if (this.listenerCount("error") > 0)
      this.#emitEvent("error", asError(error));
  }

  #emitEvent<Event extends keyof CradlewiseRealtimeEventMap>(
    event: Event,
    ...arguments_: CradlewiseRealtimeEventMap[Event]
  ): void {
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, arguments_);
      } catch (error) {
        this.#emitMessageError(error, `listener:${event}`);
      }
    }
  }

  #emitStateEvent(cradleId: string, state: CradleState, topic: string): void {
    for (const listener of this.rawListeners("state")) {
      try {
        Reflect.apply(listener, this, [
          cradleId,
          cloneCradleState(state),
          topic,
        ]);
      } catch (error) {
        this.#emitMessageError(error, "listener:state");
      }
    }
  }

  #emitMessageError(error: unknown, context?: string): void {
    for (const listener of this.rawListeners("messageError")) {
      try {
        Reflect.apply(listener, this, [error, context]);
      } catch {
        continue;
      }
    }
  }
}

function readMqttPayload(value: unknown): Uint8Array {
  const typedArray = snapshotUint8Array(value);
  if (typedArray) {
    const bytes = typedArray;
    if (bytes.byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("MQTT payload exceeds the size limit");
    }
    return bytes;
  }
  if (value instanceof ArrayBuffer) {
    const byteLength = getArrayBufferByteLength(value);
    if (byteLength === undefined) {
      throw new TypeError("MQTT payload must be an ArrayBuffer or Uint8Array");
    }
    const bytes = new Uint8Array(value);
    if (byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("MQTT payload exceeds the size limit");
    }
    return bytes;
  }
  throw new TypeError("MQTT payload must be an ArrayBuffer or Uint8Array");
}

export function isRealtimeAvailable(): Promise<boolean> {
  return Promise.resolve(false);
}

export async function isLegacyRealtimeSdkAvailable(): Promise<boolean> {
  try {
    await import("aws-iot-device-sdk-v2");
    return true;
  } catch {
    return false;
  }
}

function extractState(payload: unknown): CradleState {
  if (!isPlainObject(payload))
    throw new Error("MQTT payload must be a JSON object");
  const stateContainer = isPlainObject(payload.state)
    ? payload.state
    : undefined;
  if (!stateContainer) return payload as CradleState;
  if (isPlainObject(stateContainer.reported)) {
    return stateContainer.reported as CradleState;
  }
  if (isPlainObject(stateContainer.delta)) {
    return stateContainer.delta as CradleState;
  }
  return stateContainer as CradleState;
}

function validateMessageJsonStructure(text: string): void {
  let depth = 0;
  let separators = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_MESSAGE_DEPTH) {
        throw new Error("MQTT payload exceeds the maximum nesting depth");
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === ",") {
      separators += 1;
      if (separators >= MAX_MESSAGE_VALUES) {
        throw new Error("MQTT payload contains too many values");
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRealtimeAuthSnapshot(value: unknown):
  | {
      cognitoRegion: string;
      iotEndpoint?: string;
      ensureValid: (minimumValidityMs: number) => Promise<unknown>;
    }
  | undefined {
  if (!isObjectRecord(value)) return undefined;
  try {
    const ensureValid = value.ensureValid;
    const appConfig = value.appConfig;
    if (!isObjectRecord(appConfig)) return undefined;
    const cognitoRegion = appConfig.cognitoRegion;
    const iotEndpoint = appConfig.iotEndpoint;
    if (
      typeof ensureValid !== "function" ||
      typeof cognitoRegion !== "string" ||
      !/^[a-z]{2,4}(?:-[a-z0-9]+)+-\d+$/.test(cognitoRegion) ||
      (iotEndpoint !== undefined && typeof iotEndpoint !== "string")
    ) {
      return undefined;
    }
    return {
      cognitoRegion,
      ...(iotEndpoint === undefined ? {} : { iotEndpoint }),
      ensureValid: (minimumValidityMs: number) => {
        const result: unknown = Reflect.apply(ensureValid, value, [
          minimumValidityMs,
        ]);
        return Promise.resolve(result);
      },
    };
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface StringIterableSnapshot {
  source: object | ((...arguments_: unknown[]) => unknown);
  iterator: (...arguments_: unknown[]) => unknown;
}

function snapshotStringIterable(
  value: unknown,
): StringIterableSnapshot | undefined {
  if (
    typeof value === "string" ||
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return undefined;
  }
  try {
    const iterator: unknown = Reflect.get(value, Symbol.iterator);
    return typeof iterator === "function"
      ? {
          source: value,
          iterator: iterator as (...arguments_: unknown[]) => unknown,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function readCradleIds(values: StringIterableSnapshot): Set<string> {
  const iteratorValue: unknown = Reflect.apply(
    values.iterator,
    values.source,
    [],
  );
  if (!isObjectLike(iteratorValue)) {
    throw new TypeError("cradleIds must return an iterator object");
  }
  const next: unknown = Reflect.get(iteratorValue, "next");
  if (typeof next !== "function") {
    throw new TypeError("cradleIds must return an iterator object");
  }
  const cradleIds = new Set<string>();
  let entries = 0;
  try {
    while (true) {
      const step: unknown = Reflect.apply(next, iteratorValue, []);
      if (!isObjectRecord(step)) {
        throw new TypeError("cradleIds iterator returned an invalid result");
      }
      const done = step.done;
      if (typeof done !== "boolean") {
        throw new TypeError("cradleIds iterator returned an invalid result");
      }
      if (done) break;
      const value = step.value;
      entries += 1;
      if (entries > MAX_CRADLE_IDS) {
        throw new RangeError("Realtime supports at most 100 crib IDs");
      }
      cradleIds.add(requireCradleId(value));
    }
  } catch (error) {
    try {
      const close: unknown = Reflect.get(iteratorValue, "return");
      if (typeof close === "function") {
        Reflect.apply(close, iteratorValue, []);
      }
    } catch {
      void 0;
    }
    throw error;
  }
  return cradleIds;
}

function isObjectLike(
  value: unknown,
): value is object | ((...arguments_: unknown[]) => unknown) {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function isCredentialString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value, MAX_CREDENTIAL_BYTES) <= MAX_CREDENTIAL_BYTES &&
    value === value.trim() &&
    !hasInvalidMqttCharacter(value)
  );
}

function readRealtimeCredentials(
  value: unknown,
): CradlewiseAwsCredentials | undefined {
  if (!isObjectRecord(value)) return undefined;
  try {
    const aws = value.aws;
    if (!isObjectRecord(aws)) return undefined;
    const accessKeyId = aws.accessKeyId;
    const secretAccessKey = aws.secretAccessKey;
    const sessionToken = aws.sessionToken;
    const expiration = aws.expiration;
    const expirationTime =
      expiration instanceof Date
        ? Date.prototype.getTime.call(expiration)
        : Number.NaN;
    if (
      !isCredentialString(accessKeyId) ||
      !isCredentialString(secretAccessKey) ||
      !isCredentialString(sessionToken) ||
      !(expiration instanceof Date)
    ) {
      return undefined;
    }
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiration: new Date(expirationTime),
    };
  } catch {
    return undefined;
  }
}

function topicsForCradle(cradleId: string): string[] {
  return [
    `$aws/things/${cradleId}/shadow/get/accepted`,
    `$aws/things/${cradleId}/shadow/update/delta`,
    `${cradleId}/cradle_state`,
  ];
}

function requireCradleId(value: unknown): string {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value, 256) > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new CradlewiseRealtimeError(
      "Realtime crib IDs may contain only letters, numbers, hyphens, and underscores",
    );
  }
  return value;
}

function requireClientId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasInvalidMqttCharacter(value) ||
    utf8ByteLength(value, 128) > 128
  ) {
    throw new CradlewiseRealtimeError(
      "MQTT clientId must be 1 through 128 bytes of valid MQTT UTF-8",
    );
  }
  return value;
}

function hasInvalidMqttCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code >= 0xfdd0 && code <= 0xfdef) ||
      (code & 0xffff) >= 0xfffe
    ) {
      return true;
    }
  }
  return false;
}

function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        if (settled) {
          try {
            onLateValue?.(value);
          } catch {
            return;
          }
          return;
        }
        finish(() => resolve(value));
      },
      (error: unknown) => finish(() => reject(asError(error))),
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was aborted", { cause: signal.reason });
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("The operation failed", { cause: value });
}
