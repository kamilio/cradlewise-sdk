import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const connection = {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  };
  const builder = {
    with_clean_session: vi.fn(),
    with_client_id: vi.fn(),
    with_endpoint: vi.fn(),
    with_keep_alive_seconds: vi.fn(),
    build: vi.fn(() => ({ built: true })),
  };
  return {
    listeners,
    connection,
    builder,
    newStatic: vi.fn(() => ({ provider: true })),
    newBuilder: vi.fn(() => builder),
    newConnection: vi.fn(() => connection),
  };
});

vi.mock("aws-iot-device-sdk-v2", () => ({
  auth: { AwsCredentialsProvider: { newStatic: mocks.newStatic } },
  iot: {
    AwsIotMqttConnectionConfigBuilder: {
      new_with_websockets: mocks.newBuilder,
    },
  },
  mqtt: {
    QoS: { AtLeastOnce: 1 },
    MqttClient: class {
      new_connection = mocks.newConnection;
    },
  },
}));

import { AppConfig } from "../src/config.js";
import { Cradle } from "../src/models.js";
import {
  CradlewiseRealtime,
  isLegacyRealtimeSdkAvailable,
  isRealtimeAvailable,
} from "../src/realtime.js";
import type { CradlewiseRealtimeEventMap } from "../src/realtime.js";

function createAuth(iotEndpoint = "endpoint-ats.iot.us-east-1.amazonaws.com") {
  return {
    appConfig: new AppConfig({
      cognitoUserPoolId: "pool",
      cognitoAppClientId: "client",
      cognitoAppClientSecret: "secret",
      cognitoIdentityPoolId: "identity",
      cognitoRegion: "us-east-1",
      apiBaseUrl: "https://backend.cradlewise.com",
      ...(iotEndpoint ? { iotEndpoint } : {}),
    }),
    ensureValid: vi.fn(() =>
      Promise.resolve({
        aws: {
          accessKeyId: "key",
          secretAccessKey: "secret",
          sessionToken: "token",
          expiration: new Date(Date.now() + 60 * 60_000),
        },
      }),
    ),
  };
}

function emitConnection(event: string, ...args: unknown[]): void {
  for (const listener of mocks.listeners.get(event) ?? []) listener(...args);
}

function createConnectionMock(
  listeners: Map<string, Array<(...args: any[]) => void>>,
) {
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    }),
    connect: vi.fn(() => Promise.resolve(true)),
    disconnect: vi.fn(() => Promise.resolve(undefined)),
    subscribe: vi.fn(() => Promise.resolve({})),
    unsubscribe: vi.fn(() => Promise.resolve({})),
    publish: vi.fn(() => Promise.resolve({})),
  };
}

describe("CradlewiseRealtime", () => {
  const eventMapTypeCheck: CradlewiseRealtimeEventMap["state"] = [
    "crib",
    {},
    "topic",
  ];
  void eventMapTypeCheck;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.connection.connect.mockResolvedValue(true);
    mocks.connection.disconnect.mockResolvedValue(undefined);
    mocks.connection.subscribe.mockResolvedValue({});
    mocks.connection.unsubscribe.mockResolvedValue({});
    mocks.connection.publish.mockResolvedValue({});
  });

  it("distinguishes supported realtime from legacy SDK availability", async () => {
    await expect(isRealtimeAvailable()).resolves.toBe(false);
    await expect(isLegacyRealtimeSdkAvailable()).resolves.toBe(true);
  });

  it("requires an IoT endpoint", async () => {
    const auth = createAuth("");
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    await expect(realtime.connect()).rejects.toThrow("No AWS IoT endpoint");
    await expect(realtime.disconnect()).resolves.toBeUndefined();
  });

  it("disables the current-app-incompatible IAM transport by default", async () => {
    const auth = createAuth();
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
    });
    await expect(realtime.connect()).rejects.toThrow(
      "requires per-device certificate provisioning",
    );
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(mocks.connection.connect).not.toHaveBeenCalled();
  });

  it("rejects invalid credential refresh windows", () => {
    const auth = createAuth();
    expect(() => new CradlewiseRealtime(null as never)).toThrow(
      "options must be a plain object",
    );
    expect(
      () =>
        new CradlewiseRealtime({
          auth: {} as never,
          cradleIds: [],
        }),
    ).toThrow("CradlewiseAuth-compatible");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: auth as never,
          cradleIds: "crib-1" as never,
        }),
    ).toThrow("nonstring iterable");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: auth as never,
          cradleIds: [],
          allowLegacyIamAuthentication: "false" as never,
        }),
    ).toThrow("must be a boolean");
    const immutableRealtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
    });
    expect(Reflect.set(immutableRealtime, "auth", {})).toBe(false);
    expect(immutableRealtime.auth).toBe(auth);
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          credentialRefreshWindowMs: -1,
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          operationTimeoutMs: 0,
        }),
    ).toThrow("operationTimeoutMs");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          credentialRefreshWindowMs: 1.5,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          credentialRefreshWindowMs: Number.POSITIVE_INFINITY,
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          credentialRefreshWindowMs: 2_147_483_648,
        }),
    ).toThrow(RangeError);
  });

  it("rejects unsafe endpoints and MQTT topic identifiers", async () => {
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          iotEndpoint: "attacker.example.com",
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("AWS IoT ATS hostname");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          iotEndpoint: "",
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("AWS IoT ATS hostname");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: ["crib/#"],
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("crib IDs");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: Array.from({ length: 101 }, (_, index) => `crib-${index}`),
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("at most 100 crib IDs");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: ["a".repeat(257)],
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("crib IDs");

    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await expect(realtime.addCradle("+")).rejects.toThrow("crib IDs");
    await expect(realtime.addCradle("a".repeat(257))).rejects.toThrow(
      "crib IDs",
    );
    await expect(realtime.removeCradle("+")).rejects.toThrow("crib IDs");
    const fullRealtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: Array.from({ length: 100 }, (_, index) => `crib-${index}`),
      allowLegacyIamAuthentication: true,
    });
    await expect(fullRealtime.addCradle("overflow")).rejects.toThrow(
      "at most 100 crib IDs",
    );
    const exposed = realtime.cradleIds as Set<string>;
    exposed.add("crib-2");
    expect(realtime.cradleIds.has("crib-2")).toBe(false);

    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          clientId: "x".repeat(129),
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow("clientId");
    for (const clientId of ["line\nbreak", "\u0085", "\ud800", "\uffff"]) {
      expect(
        () =>
          new CradlewiseRealtime({
            auth: createAuth() as never,
            cradleIds: [],
            clientId,
          }),
      ).toThrow("clientId");
    }
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          client: {} as never,
        }),
    ).toThrow("cradles Map");
    expect(
      () =>
        new CradlewiseRealtime({
          auth: createAuth() as never,
          cradleIds: [],
          onStateUpdate: "not-a-function" as never,
          allowLegacyIamAuthentication: true,
        }),
    ).toThrow(TypeError);
  });

  it("snapshots a compatible auth adapter's Cognito region", async () => {
    const auth = createAuth();
    const mutableConfig = {
      cognitoRegion: auth.appConfig.cognitoRegion,
      iotEndpoint: auth.appConfig.iotEndpoint,
    };
    const realtime = new CradlewiseRealtime({
      auth: { ...auth, appConfig: mutableConfig } as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    mutableConfig.cognitoRegion = "eu-west-1";

    await realtime.connect();

    expect(mocks.newBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ region: "us-east-1" }),
    );
    await realtime.disconnect();
  });

  it("reads compatible realtime auth config only once", async () => {
    const auth = createAuth();
    let configReads = 0;
    const rotatingAuth = { ...auth } as Record<string, unknown>;
    Object.defineProperty(rotatingAuth, "appConfig", {
      get: () => {
        configReads += 1;
        return configReads === 1
          ? auth.appConfig
          : {
              cognitoRegion: "eu-west-1",
              iotEndpoint: "attacker-ats.iot.eu-west-1.amazonaws.com",
            };
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: rotatingAuth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });

    await realtime.connect();

    expect(configReads).toBe(1);
    expect(mocks.newBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ region: "us-east-1" }),
    );
    expect(mocks.builder.with_endpoint).toHaveBeenCalledWith(
      "endpoint-ats.iot.us-east-1.amazonaws.com",
    );
    await realtime.disconnect();
  });

  it("snapshots the compatible auth validation method", async () => {
    const auth = createAuth();
    const originalEnsureValid = auth.ensureValid;
    const rotatingAuth = { ...auth };
    const realtime = new CradlewiseRealtime({
      auth: rotatingAuth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    rotatingAuth.ensureValid = vi.fn(() =>
      Promise.reject(new Error("mutated auth method")),
    );

    await realtime.connect();

    expect(originalEnsureValid).toHaveBeenCalledOnce();
    expect(rotatingAuth.ensureValid).not.toHaveBeenCalled();
    await realtime.disconnect();
  });

  it("snapshots realtime constructor option getters once", async () => {
    const auth = createAuth();
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      auth,
      cradleIds: [] as string[],
      iotEndpoint: auth.appConfig.iotEndpoint,
      clientId: "client-id",
      credentialRefreshWindowMs: 60_000,
      operationTimeoutMs: 1_000,
      allowLegacyIamAuthentication: true,
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const realtime = new CradlewiseRealtime(options as never);
    await realtime.connect();

    expect(Object.fromEntries(reads)).toEqual({
      auth: 1,
      cradleIds: 1,
      iotEndpoint: 1,
      clientId: 1,
      credentialRefreshWindowMs: 1,
      operationTimeoutMs: 1,
      allowLegacyIamAuthentication: 1,
    });
    await realtime.disconnect();
  });

  it("snapshots the crib ID iterator and iterator methods once", () => {
    let iteratorReads = 0;
    let nextReads = 0;
    const iterable = {};
    Object.defineProperty(iterable, Symbol.iterator, {
      get: () => {
        iteratorReads += 1;
        if (iteratorReads > 1) throw new Error("iterator changed");
        let delivered = false;
        const iterator = {};
        Object.defineProperty(iterator, "next", {
          get: () => {
            nextReads += 1;
            return () => {
              if (delivered) return { done: true };
              delivered = true;
              return { done: false, value: "crib-1" };
            };
          },
        });
        return () => iterator;
      },
    });

    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: iterable as never,
    });

    expect(iteratorReads).toBe(1);
    expect(nextReads).toBe(1);
    expect([...realtime.cradleIds]).toEqual(["crib-1"]);
  });

  it("reconciles crib additions during initial subscriptions", async () => {
    let releaseSubscription!: () => void;
    mocks.connection.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubscription = () => resolve({});
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });

    const connecting = realtime.connect();
    await vi.waitFor(() =>
      expect(mocks.connection.subscribe).toHaveBeenCalledOnce(),
    );
    expect(realtime.connected).toBe(false);
    await realtime.addCradle("crib-2");
    releaseSubscription();
    await connecting;

    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(6);
    expect(realtime.connected).toBe(true);
  });

  it("does not report connected after an initialization interrupt", async () => {
    let releaseSubscription!: () => void;
    mocks.connection.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubscription = () => resolve({});
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });

    const connecting = realtime.connect();
    await vi.waitFor(() =>
      expect(mocks.connection.subscribe).toHaveBeenCalledOnce(),
    );
    emitConnection("interrupt", new Error("network"));
    releaseSubscription();

    await expect(connecting).rejects.toThrow("Unable to connect");
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
  });

  it("rolls back a crib removed during initial subscriptions", async () => {
    let releaseSubscription!: () => void;
    mocks.connection.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubscription = () => resolve({});
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });

    const connecting = realtime.connect();
    await vi.waitFor(() =>
      expect(mocks.connection.subscribe).toHaveBeenCalledOnce(),
    );
    await realtime.removeCradle("crib-1");
    releaseSubscription();
    await connecting;

    expect(realtime.cradleIds.has("crib-1")).toBe(false);
    expect(mocks.connection.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.connection.publish).not.toHaveBeenCalled();
    expect(realtime.connected).toBe(true);
  });

  it("coalesces connects, subscribes, and applies shadow messages", async () => {
    const auth = createAuth();
    const cradle = new Cradle({
      cradleId: "crib-1",
      state: { music: { volume: 4 } },
    });
    const client = { cradles: new Map([[cradle.cradleId, cradle]]) };
    const onStateUpdate = vi.fn();
    const onState = vi.fn();
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      client: client as never,
      cradleIds: [cradle.cradleId],
      onStateUpdate,
      clientId: "test-client",
      allowLegacyIamAuthentication: true,
    });
    realtime.on("state", onState);
    await Promise.all([realtime.connect(), realtime.connect()]);

    expect(auth.ensureValid).toHaveBeenCalledOnce();
    expect(mocks.connection.connect).toHaveBeenCalledOnce();
    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(3);
    expect(mocks.connection.publish).toHaveBeenCalledWith(
      "$aws/things/crib-1/shadow/get",
      "{}",
      1,
    );
    expect(mocks.builder.with_client_id).toHaveBeenCalledWith("test-client");
    expect(realtime.connected).toBe(true);

    const callback = mocks.connection.subscribe.mock.calls[0]![2] as (
      topic: string,
      payload: unknown,
    ) => void;
    callback(
      "$aws/things/crib-1/shadow/get/accepted",
      new TextEncoder().encode(
        JSON.stringify({ state: { reported: { music: { play: true } } } }),
      ),
    );
    expect(cradle.state.music).toEqual({ volume: 4, play: true });
    expect(onStateUpdate).toHaveBeenCalledWith("crib-1", {
      music: { play: true },
    });
    expect(onState).toHaveBeenCalled();

    await realtime.removeCradle("crib-1");
    callback(
      "$aws/things/crib-1/shadow/update/delta",
      new TextEncoder().encode(
        JSON.stringify({ state: { music: { play: false } } }),
      ),
    );
    expect(cradle.state.music).toEqual({ volume: 4, play: true });
    expect(onStateUpdate).toHaveBeenCalledTimes(1);
  });

  it("reconnects when connect is requested during a disconnect", async () => {
    let finishInitialConnect!: () => void;
    mocks.connection.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitialConnect = () => resolve(true);
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });

    const initialConnect = realtime.connect();
    await vi.waitFor(() => expect(mocks.connection.connect).toHaveBeenCalled());
    const disconnect = realtime.disconnect();
    const reconnect = realtime.connect();
    finishInitialConnect();

    await Promise.all([initialConnect, disconnect, reconnect]);
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(true);
  });

  it("resubscribes after a resumed clean session", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    const onInterrupt = vi.fn();
    const onResume = vi.fn();
    realtime.on("interrupt", onInterrupt);
    realtime.on("resume", onResume);
    await realtime.connect();

    emitConnection("interrupt", new Error("network"));
    expect(realtime.connected).toBe(false);
    expect(onInterrupt).toHaveBeenCalledOnce();
    emitConnection("resume", 0, false);
    await vi.waitFor(() =>
      expect(mocks.connection.subscribe).toHaveBeenCalledTimes(6),
    );
    expect(mocks.connection.publish).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenCalledWith(0, false);
  });

  it("coalesces duplicate clean-session resume recovery", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    emitConnection("interrupt", new Error("network"));
    let releaseRecovery!: () => void;
    mocks.connection.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRecovery = () => resolve({});
        }),
    );

    emitConnection("resume", 0, false);
    emitConnection("resume", 0, false);
    await vi.waitFor(() =>
      expect(mocks.connection.subscribe).toHaveBeenCalledTimes(4),
    );
    releaseRecovery();
    await vi.waitFor(() => expect(realtime.connected).toBe(true));

    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(6);
  });

  it("replaces an interrupted connection before manual reconnect", async () => {
    const firstListeners = new Map<string, Array<(...args: any[]) => void>>();
    const secondListeners = new Map<string, Array<(...args: any[]) => void>>();
    const first = createConnectionMock(firstListeners);
    const second = createConnectionMock(secondListeners);
    mocks.newConnection.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    for (const listener of firstListeners.get("interrupt") ?? []) {
      listener(new Error("network"));
    }

    await realtime.connect();

    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.connect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(true);
  });

  it("does not replace an interrupted connection after a newer disconnect", async () => {
    const firstListeners = new Map<string, Array<(...args: any[]) => void>>();
    const first = createConnectionMock(firstListeners);
    let resolveDisconnect!: () => void;
    first.disconnect.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolveDisconnect = () => resolve(undefined);
      }),
    );
    mocks.newConnection.mockReturnValueOnce(first);
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    for (const listener of firstListeners.get("interrupt") ?? []) {
      listener(new Error("network"));
    }

    const reconnecting = realtime.connect();
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledOnce());
    const disconnecting = realtime.disconnect();
    resolveDisconnect();
    await Promise.all([reconnecting, disconnecting]);

    expect(mocks.connection.connect).not.toHaveBeenCalled();
    expect(realtime.connected).toBe(false);
  });

  it("reconnects when clean-session resubscription fails", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    emitConnection("interrupt", new Error("network"));
    mocks.connection.subscribe.mockRejectedValueOnce(new Error("denied"));

    emitConnection("resume", 0, false);

    await vi.waitFor(() =>
      expect(mocks.connection.connect).toHaveBeenCalledTimes(2),
    );
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(true);
  });

  it("ignores lifecycle events from replaced connections", async () => {
    const firstListeners = new Map<string, Array<(...args: any[]) => void>>();
    const secondListeners = new Map<string, Array<(...args: any[]) => void>>();
    const first = createConnectionMock(firstListeners);
    const second = createConnectionMock(secondListeners);
    mocks.newConnection.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const onDisconnect = vi.fn();
    realtime.on("interrupt", onInterrupt);
    realtime.on("error", onError);
    realtime.on("disconnect", onDisconnect);

    await realtime.connect();
    await realtime.reconnect();
    expect(onDisconnect).toHaveBeenCalledOnce();
    for (const listener of firstListeners.get("interrupt") ?? []) {
      listener(new Error("stale interrupt"));
    }
    for (const listener of firstListeners.get("error") ?? []) {
      listener(new Error("stale error"));
    }
    for (const listener of firstListeners.get("disconnect") ?? []) listener();

    expect(realtime.connected).toBe(true);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    for (const listener of secondListeners.get("interrupt") ?? []) {
      listener(new Error("current interrupt"));
    }
    expect(realtime.connected).toBe(false);
    expect(onInterrupt).toHaveBeenCalledOnce();
    await realtime.disconnect();
    for (const listener of firstListeners.get("disconnect") ?? []) listener();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("emits one disconnect event for an explicit active disconnect", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const onDisconnect = vi.fn();
    realtime.on("disconnect", onDisconnect);
    await realtime.connect();

    await Promise.all([realtime.disconnect(), realtime.disconnect()]);

    expect(onDisconnect).toHaveBeenCalledOnce();
    emitConnection("disconnect");
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("ignores duplicate remote disconnect callbacks", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const onDisconnect = vi.fn();
    realtime.on("disconnect", onDisconnect);
    await realtime.connect();

    emitConnection("disconnect");
    emitConnection("disconnect");

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
    await realtime.disconnect();
  });

  it("does not reconnect after a newer explicit disconnect", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    let resolveDisconnect!: () => void;
    mocks.connection.disconnect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      }),
    );

    const reconnecting = realtime.reconnect();
    await vi.waitFor(() => {
      expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    });
    const disconnecting = realtime.disconnect();
    resolveDisconnect();
    await Promise.all([reconnecting, disconnecting]);

    expect(mocks.connection.connect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
  });

  it("adds and removes subscriptions without leaving failed additions", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    await realtime.addCradle("crib-2");
    expect(realtime.cradleIds.has("crib-2")).toBe(true);
    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(6);
    await realtime.removeCradle("crib-2");
    expect(realtime.cradleIds.has("crib-2")).toBe(false);
    expect(mocks.connection.unsubscribe).toHaveBeenCalledTimes(3);

    mocks.connection.subscribe
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("denied"));
    await expect(realtime.addCradle("crib-3")).rejects.toThrow(
      "Unable to subscribe",
    );
    expect(realtime.cradleIds.has("crib-3")).toBe(false);
    expect(mocks.connection.unsubscribe).toHaveBeenCalledTimes(4);
  });

  it("reconnects with the reduced set if removal cannot unsubscribe", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1", "crib-2"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    mocks.connection.unsubscribe.mockRejectedValueOnce(new Error("denied"));

    await expect(realtime.removeCradle("crib-2")).resolves.toBeUndefined();
    expect(realtime.cradleIds.has("crib-2")).toBe(false);
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(9);
  });

  it("reconnects when a late removal overlaps a successful re-addition", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    const resolveUnsubscribes: Array<() => void> = [];
    mocks.connection.unsubscribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUnsubscribes.push(() => resolve({}));
        }),
    );

    const removal = realtime.removeCradle("crib-1");
    await vi.waitFor(() => {
      expect(resolveUnsubscribes).toHaveLength(3);
    });
    await realtime.addCradle("crib-1");
    for (const resolve of resolveUnsubscribes) resolve();
    await removal;

    expect(realtime.cradleIds.has("crib-1")).toBe(true);
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(9);
    expect(realtime.connected).toBe(true);
  });

  it("reconnects if a failed addition cannot roll back subscriptions", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    mocks.connection.subscribe
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("subscribe denied"));
    mocks.connection.unsubscribe.mockRejectedValueOnce(
      new Error("unsubscribe denied"),
    );

    await expect(realtime.addCradle("crib-2")).rejects.toThrow(
      "Unable to subscribe",
    );
    expect(realtime.cradleIds.has("crib-2")).toBe(false);
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(realtime.connected).toBe(true);
  });

  it("cleans up failed connections and allows a retry", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    mocks.connection.connect.mockRejectedValueOnce(new Error("handshake"));
    await expect(realtime.connect()).rejects.toThrow("Unable to connect");
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);

    await expect(realtime.connect()).resolves.toBeUndefined();
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(realtime.connected).toBe(true);
  });

  it("reports invalid messages without crashing", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    const onMessageError = vi.fn();
    realtime.on("messageError", onMessageError);
    await realtime.connect();
    const callback = mocks.connection.subscribe.mock.calls[0]![2] as (
      topic: string,
      payload: unknown,
    ) => void;
    callback("topic", new TextEncoder().encode("[]"));
    callback("topic", new TextEncoder().encode("not-json"));
    callback(
      "topic",
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
    );
    callback("topic", new TextEncoder().encode('{"value":1e400}'));
    callback(
      "topic",
      new TextEncoder().encode(`${"[".repeat(101)}0${"]".repeat(101)}`),
    );
    callback("topic", new Uint8Array(1024 * 1024 + 1));
    const shadowedLength = new Uint8Array(1024 * 1024 + 1);
    Object.defineProperty(shadowedLength, "byteLength", { value: 0 });
    callback("topic", shadowedLength);
    callback("topic", { 0: 123, length: 1 });
    expect(onMessageError).toHaveBeenCalledTimes(8);
    expect(onMessageError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "MQTT payload must be an ArrayBuffer or Uint8Array",
      }),
      "topic",
    );
  });

  it("delivers state events when the option callback throws", async () => {
    const onState = vi.fn();
    const onMessageError = vi.fn();
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      onStateUpdate: () => {
        throw new Error("consumer failed");
      },
      allowLegacyIamAuthentication: true,
    });
    realtime.on("state", onState);
    realtime.on("messageError", onMessageError);
    await realtime.connect();
    const callback = mocks.connection.subscribe.mock.calls[0]![2] as (
      topic: string,
      payload: Uint8Array,
    ) => void;

    callback(
      "topic",
      new TextEncoder().encode(JSON.stringify({ state: { mode: "normal" } })),
    );

    expect(onMessageError).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith("crib-1", { mode: "normal" }, "topic");
  });

  it("isolates state snapshots between callbacks and listeners", async () => {
    const secondListener = vi.fn();
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      onStateUpdate: (_cradleId, state) => {
        state.mode = "callback-mutated";
      },
      allowLegacyIamAuthentication: true,
    });
    realtime.on("state", (_cradleId, state) => {
      state.mode = "listener-mutated";
    });
    realtime.on("state", secondListener);
    await realtime.connect();
    const callback = mocks.connection.subscribe.mock.calls[0]![2] as (
      topic: string,
      payload: Uint8Array,
    ) => void;

    callback(
      "topic",
      new TextEncoder().encode(JSON.stringify({ state: { mode: "normal" } })),
    );

    expect(secondListener).toHaveBeenCalledWith(
      "crib-1",
      { mode: "normal" },
      "topic",
    );
  });

  it("contains throwing state and message-error listeners", async () => {
    const delivered = vi.fn();
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      allowLegacyIamAuthentication: true,
    });
    realtime.on("state", () => {
      throw new Error("state listener failed");
    });
    realtime.on("messageError", () => {
      throw new Error("message error listener failed");
    });
    realtime.on("messageError", delivered);
    await realtime.connect();
    const callback = mocks.connection.subscribe.mock.calls[0]![2] as (
      topic: string,
      payload: Uint8Array,
    ) => void;

    expect(() =>
      callback(
        "topic",
        new TextEncoder().encode(JSON.stringify({ state: { mode: "normal" } })),
      ),
    ).not.toThrow();
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ message: "state listener failed" }),
      "listener:state",
    );
  });

  it("contains throwing lifecycle and error listeners", async () => {
    const onMessageError = vi.fn();
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const throwingListener = (event: string) => () => {
      throw new Error(`${event} listener failed`);
    };
    realtime.on("connect", throwingListener("connect"));
    realtime.on("interrupt", throwingListener("interrupt"));
    realtime.on("resume", throwingListener("resume"));
    realtime.on("disconnect", throwingListener("disconnect"));
    realtime.on("error", throwingListener("error"));
    realtime.on("messageError", onMessageError);

    await expect(realtime.connect()).resolves.toBeUndefined();
    expect(() =>
      emitConnection("interrupt", new Error("network")),
    ).not.toThrow();
    expect(() => emitConnection("resume", 0, true)).not.toThrow();
    expect(() => emitConnection("error", new Error("transport"))).not.toThrow();
    await expect(realtime.disconnect()).resolves.toBeUndefined();
    expect(onMessageError).toHaveBeenCalledWith(
      expect.any(Error),
      "listener:connect",
    );
    expect(onMessageError).toHaveBeenCalledWith(
      expect.any(Error),
      "listener:interrupt",
    );
    expect(onMessageError).toHaveBeenCalledWith(
      expect.any(Error),
      "listener:resume",
    );
    expect(onMessageError).toHaveBeenCalledWith(
      expect.any(Error),
      "listener:error",
    );
    expect(onMessageError).toHaveBeenCalledWith(
      expect.any(Error),
      "listener:disconnect",
    );
  });

  it("disconnects cleanly even when the SDK disconnect rejects", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const onError = vi.fn();
    realtime.on("error", onError);
    await realtime.connect();
    mocks.connection.disconnect.mockRejectedValueOnce(
      new Error("already closed"),
    );
    await expect(realtime.disconnect()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
  });

  it("times out stalled MQTT connect operations", async () => {
    mocks.connection.connect.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
  });

  it("disconnects MQTT connections that complete after timing out", async () => {
    let resolveConnect!: () => void;
    mocks.connection.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve(true);
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    resolveConnect();
    await vi.waitFor(() =>
      expect(mocks.connection.disconnect).toHaveBeenCalledTimes(2),
    );
  });

  it("times out stalled realtime credential acquisition", async () => {
    const auth = createAuth();
    auth.ensureValid.mockImplementationOnce(() => new Promise(() => undefined));
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed realtime AWS credentials before connecting", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      aws: {
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: " ",
        expiration: new Date("2030-01-01T00:00:00Z"),
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({
        message: "Realtime authentication returned invalid AWS credentials",
      }),
    });
    expect(mocks.connection.connect).not.toHaveBeenCalled();
  });

  it("rejects oversized realtime AWS credentials before connecting", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      aws: {
        accessKeyId: "x".repeat(128 * 1024 + 1),
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date(Date.now() + 60 * 60_000),
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({
        message: "Realtime authentication returned invalid AWS credentials",
      }),
    });
    expect(mocks.connection.connect).not.toHaveBeenCalled();
  });

  it("snapshots realtime credential fields once", async () => {
    const auth = createAuth();
    const reads = new Map<string, number>();
    const values = {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: new Date(Date.now() + 60 * 60_000),
    };
    const descriptors = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: () => {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return value;
          },
        },
      ]),
    );
    const credentialObject = { aws: {} as Record<string, unknown> };
    Object.defineProperties(credentialObject.aws, descriptors);
    auth.ensureValid.mockResolvedValueOnce(credentialObject as never);
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });

    await realtime.connect();

    expect(Object.fromEntries(reads)).toEqual({
      accessKeyId: 1,
      secretAccessKey: 1,
      sessionToken: 1,
      expiration: 1,
    });
    await realtime.disconnect();
  });

  it("times out stalled MQTT subscription operations", async () => {
    mocks.connection.subscribe.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
    expect(realtime.connected).toBe(false);
  });

  it("removes MQTT subscriptions that complete after timing out", async () => {
    let resolveSubscribe!: () => void;
    mocks.connection.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = () => resolve({});
        }),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    resolveSubscribe();
    await vi.waitFor(() =>
      expect(mocks.connection.unsubscribe).toHaveBeenCalledWith(
        "$aws/things/crib-1/shadow/get/accepted",
      ),
    );
  });

  it("applies one deadline to the full initial connection", async () => {
    mocks.connection.subscribe.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 15)),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      operationTimeoutMs: 25,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.subscribe).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(mocks.connection.unsubscribe).toHaveBeenCalledTimes(2),
    );
    expect(realtime.connected).toBe(false);
  });

  it("times out a stalled MQTT initial-state publish", async () => {
    mocks.connection.publish.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.connection.unsubscribe).toHaveBeenCalledTimes(3);
    expect(mocks.connection.disconnect).toHaveBeenCalledOnce();
  });

  it("bounds stalled MQTT unsubscriptions and recovers", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: ["crib-1"],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });
    await realtime.connect();
    mocks.connection.unsubscribe.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    await expect(realtime.removeCradle("crib-1")).resolves.toBeUndefined();
    expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
    expect(realtime.connected).toBe(true);
    await realtime.disconnect();
  });

  it("bounds a stalled MQTT disconnect operation", async () => {
    const realtime = new CradlewiseRealtime({
      auth: createAuth() as never,
      cradleIds: [],
      operationTimeoutMs: 20,
      allowLegacyIamAuthentication: true,
    });
    const onError = vi.fn();
    realtime.on("error", onError);
    await realtime.connect();
    mocks.connection.disconnect.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    await expect(realtime.disconnect()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "TimeoutError" }),
    );
    expect(realtime.connected).toBe(false);
  });

  it("refreshes credentials on schedule and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const auth = createAuth();
      const realtime = new CradlewiseRealtime({
        auth: auth as never,
        cradleIds: [],
        allowLegacyIamAuthentication: true,
      });
      await realtime.connect();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(56 * 60_000);
      await vi.waitFor(() => expect(auth.ensureValid).toHaveBeenCalledTimes(2));
      expect(mocks.connection.connect).toHaveBeenCalledTimes(2);
      expect(realtime.connected).toBe(true);

      await realtime.disconnect();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid realtime credential expiration dates", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      aws: {
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date(Number.NaN),
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const error = await realtime.connect().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "CradlewiseRealtimeError" });
    expect((error as Error).cause).toMatchObject({
      message: "Realtime credentials have an invalid expiration date",
    });
    expect(realtime.connected).toBe(false);
    expect(mocks.newStatic).not.toHaveBeenCalled();
  });

  it("rejects already expired realtime credentials", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      aws: {
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date(0),
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      allowLegacyIamAuthentication: true,
    });
    const error = await realtime.connect().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "CradlewiseRealtimeError" });
    expect((error as Error).cause).toMatchObject({
      message: "Realtime credentials are already expired",
    });
    expect(mocks.newStatic).not.toHaveBeenCalled();
  });

  it("rejects realtime credentials inside the refresh window", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      aws: {
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date(Date.now() + 60_000),
      },
    });
    const realtime = new CradlewiseRealtime({
      auth: auth as never,
      cradleIds: [],
      credentialRefreshWindowMs: 5 * 60_000,
      allowLegacyIamAuthentication: true,
    });

    await expect(realtime.connect()).rejects.toMatchObject({
      name: "CradlewiseRealtimeError",
      cause: expect.objectContaining({
        message: "Realtime credentials have insufficient remaining validity",
      }),
    });
    expect(mocks.newStatic).not.toHaveBeenCalled();
  });
});
