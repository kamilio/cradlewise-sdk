import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { CradlewiseController } from "../src/controls.js";
import { Cradle } from "../src/models.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Stage =
  | "credentials"
  | "bootstrap"
  | "download"
  | "connect"
  | "subscribe"
  | "publish"
  | "end";

function fixture(stage?: Stage) {
  const entered = deferred();
  const release = deferred();
  let held = false;
  const hold = async (current: Stage) => {
    if (stage === current && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  const published: Array<{ topic: string; body: { clientToken: string } }> = [];
  let respond = true;
  let rejectNext = false;
  class Connection extends EventEmitter {
    connected = true;
    endCalls = 0;
    async subscribeAsync() {
      await hold("subscribe");
    }
    async unsubscribeAsync() {}
    async publishAsync(topic: string, payload: string) {
      const body = JSON.parse(payload) as { clientToken: string };
      published.push({ topic, body });
      await hold("publish");
      if (respond) {
        this.emit(
          "message",
          `${topic}/${rejectNext ? "rejected" : "accepted"}`,
          Buffer.from(JSON.stringify(body)),
        );
        rejectNext = false;
      }
    }
    async endAsync() {
      this.endCalls += 1;
      await hold("end");
      this.connected = false;
      this.emit("close");
    }
  }
  const connections: Connection[] = [];
  const mqttConnect = vi.fn(async () => {
    await hold("connect");
    const connection = new Connection();
    connections.push(connection);
    return connection;
  });
  const credentials = {
    aws: {
      accessKeyId: "fixture",
      secretAccessKey: "fixture",
      sessionToken: "fixture",
      expiration: new Date(Date.now() + 3_600_000),
    },
    tokens: {
      idToken: "fixture",
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  };
  const auth = {
    appConfig: new AppConfig({
      cognitoUserPoolId: "pool",
      cognitoAppClientId: "client",
      cognitoAppClientSecret: "fixture",
      cognitoIdentityPoolId: "identity",
      cognitoRegion: "us-east-1",
      apiBaseUrl: "https://backend.cradlewise.com",
      iotEndpoint: "fixture-ats.iot.us-east-1.amazonaws.com",
    }),
    email: "fixture@example.invalid",
    ensureValid: async () => {
      await hold("credentials");
      return credentials;
    },
    authenticate: () => Promise.resolve(credentials),
  };
  const fetchMock: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/cradles/pairedUsers/v3")) {
      await hold("bootstrap");
      return Response.json({
        device_config: {
          cradle_id: "crib",
          device_id: "device",
          s3_bucket: "bucket",
          s3_object_keys: ["cert", "key"],
        },
      });
    }
    if (url.includes(".s3.us-east-1.amazonaws.com/")) {
      await hold("download");
      return new Response("fixture");
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const controller = new CradlewiseController(
    auth as never,
    new Cradle({ cradleId: "crib", babyId: "123" }),
    { fetch: fetchMock, mqttConnect, operationTimeoutMs: 1_000 },
  );
  return {
    controller,
    entered,
    release,
    connections,
    published,
    mqttConnect,
    setRespond: (value: boolean) => {
      respond = value;
    },
    rejectNext: () => {
      rejectNext = true;
    },
  };
}

function outcome(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("controller disconnect lifecycle", () => {
  for (const stage of [
    "credentials",
    "bootstrap",
    "download",
    "connect",
    "subscribe",
  ] as const) {
    for (const operation of ["control", "state", "connect"] as const) {
      if (stage === "subscribe" && operation === "connect") continue;
      it(`cancels ${operation} waiting for ${stage} without publishing`, async () => {
        const harness = fixture(stage);
        const { controller, entered, release, connections, published } =
          harness;
        const pending = outcome(
          operation === "control"
            ? controller.setSoundLevel(50)
            : operation === "state"
              ? controller.getState()
              : controller.connect(),
        );
        try {
          await entered.promise;
          const teardown = controller.disconnect();
          release.resolve();
          await teardown;
          expect(await pending).toMatchObject({
            error: expect.objectContaining({
              message: "Crib control connection closed",
            }),
          });
          expect(published).toHaveLength(0);
          expect(
            connections.every(
              (connection) =>
                !connection.connected && connection.endCalls === 1,
            ),
          ).toBe(true);
          if (["credentials", "bootstrap", "download"].includes(stage))
            expect(harness.mqttConnect).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await pending;
          await controller.disconnect();
        }
      });
    }
  }

  it("cancels updates enqueued before their first microtask", async () => {
    const { controller, mqttConnect } = fixture();
    const pending = [
      outcome(controller.setSoundLevel(10)),
      outcome(controller.stop()),
    ];
    await controller.disconnect();
    for (const result of await Promise.all(pending))
      expect(result).toHaveProperty("error");
    expect(mqttConnect).not.toHaveBeenCalled();
  });

  it("cancels a pending connect call even when its transport was already available", async () => {
    const { controller, mqttConnect } = fixture();
    await controller.connect();
    const pending = outcome(controller.connect());
    await controller.disconnect();
    expect(await pending).toHaveProperty("error");
    expect(mqttConnect).toHaveBeenCalledTimes(1);
  });

  it("cancels active and queued controls without reconnecting", async () => {
    const { controller, published, mqttConnect, setRespond } = fixture();
    setRespond(false);
    const pending = [
      outcome(controller.setSoundLevel(10)),
      outcome(controller.setSoundLevel(50)),
      outcome(controller.lock()),
    ];
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await controller.disconnect();
    for (const result of await Promise.all(pending))
      expect(result).toHaveProperty("error");
    expect(published).toHaveLength(1);
    expect(mqttConnect).toHaveBeenCalledTimes(1);
    setRespond(true);
    await expect(controller.setSoundLevel(30)).resolves.toMatchObject({
      soundLevel: 30,
    });
    await controller.disconnect();
  });

  it("rejects controls while a publish acknowledgement is pending", async () => {
    const { controller, entered, release, published } = fixture("publish");
    let settled = false;
    const pending = outcome(controller.setSoundLevel(50)).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered.promise;
      await controller.disconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeRelease = settled;
      release.resolve();
      expect(settledBeforeRelease).toBe(true);
      expect(await pending).toHaveProperty("error");
      await expect(controller.lock()).resolves.toMatchObject({ soundLevel: 0 });
      expect(published).toHaveLength(2);
    } finally {
      release.resolve();
      await controller.disconnect();
    }
  });

  it("waits for a late connection to close before allowing reuse", async () => {
    const {
      controller,
      entered,
      release,
      connections,
      mqttConnect,
      published,
    } = fixture("connect");
    const original = outcome(controller.setSoundLevel(10));
    await entered.promise;
    let disconnected = false;
    const teardown = controller.disconnect().then(() => {
      disconnected = true;
    });
    const fresh = outcome(controller.setSoundLevel(50));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disconnected).toBe(false);
      expect(mqttConnect).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await teardown;
    expect(await original).toHaveProperty("error");
    expect(await fresh).toMatchObject({ value: { soundLevel: 50 } });
    expect(connections[0]).toMatchObject({ connected: false, endCalls: 1 });
    expect(published).toHaveLength(1);
    await controller.disconnect();
  });

  it("serializes repeated teardown and explicit reuse behind connection close", async () => {
    const { controller, entered, release, connections, mqttConnect } =
      fixture("end");
    await controller.connect();
    const first = controller.disconnect();
    await entered.promise;
    const cancelled = outcome(controller.setSoundLevel(10));
    const second = controller.disconnect();
    const fresh = outcome(controller.setSoundLevel(50));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mqttConnect).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await Promise.all([first, second]);
    expect(await cancelled).toHaveProperty("error");
    expect(await fresh).toMatchObject({ value: { soundLevel: 50 } });
    connections[0]?.emit("close");
    await expect(controller.lock()).resolves.toMatchObject({
      soundLevel: 50,
      locked: true,
    });
    expect(mqttConnect).toHaveBeenCalledTimes(2);
    expect(connections[0]?.endCalls).toBe(1);
    await controller.disconnect();
  });

  it("still advances the queue after a normal request rejection", async () => {
    const { controller, rejectNext, published, mqttConnect } = fixture();
    rejectNext();
    const first = outcome(controller.setSoundLevel(10));
    const second = controller.setSoundLevel(50);
    expect(await first).toHaveProperty("error");
    await expect(second).resolves.toMatchObject({ soundLevel: 50 });
    expect(published).toHaveLength(2);
    expect(mqttConnect).toHaveBeenCalledTimes(1);
    await controller.disconnect();
  });

  it("settles cancelled controls before a late connection becomes available", async () => {
    const { controller, entered, release, connections } = fixture("connect");
    let result: unknown;
    const pending = outcome(controller.setSoundLevel(10)).then((value) => {
      result = value;
    });
    await entered.promise;
    const teardown = controller.disconnect();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result).toHaveProperty("error");
      expect(connections).toHaveLength(0);
    } finally {
      release.resolve();
    }
    await Promise.all([pending, teardown]);
    expect(connections[0]).toMatchObject({ connected: false, endCalls: 1 });
  });

  it("handles a pending connection failure during teardown and permits reuse", async () => {
    const { controller, mqttConnect, entered, release } = fixture();
    mqttConnect.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("Connect failed");
    });
    const pending = outcome(controller.connect());
    await entered.promise;
    const teardown = controller.disconnect();
    release.resolve();
    await teardown;
    expect(await pending).toHaveProperty("error");
    await expect(controller.setSoundLevel(25)).resolves.toMatchObject({
      soundLevel: 25,
    });
    await controller.disconnect();
  });

  it("continues queued updates after an ordinary connection failure", async () => {
    const { controller, mqttConnect, published } = fixture();
    mqttConnect.mockRejectedValueOnce(new Error("Connect failed"));
    const first = outcome(controller.setSoundLevel(10));
    const second = controller.setSoundLevel(25);
    expect(await first).toHaveProperty("error");
    await expect(second).resolves.toMatchObject({ soundLevel: 25 });
    expect(published).toHaveLength(1);
    expect(mqttConnect).toHaveBeenCalledTimes(2);
    await controller.disconnect();
  });

  it("reports connection-close failures instead of claiming teardown succeeded", async () => {
    const { controller, connections } = fixture();
    await controller.connect();
    const connection = connections[0]!;
    const failure = new Error("Close failed");
    const end = vi.spyOn(connection, "endAsync").mockRejectedValueOnce(failure);
    await expect(controller.disconnect()).rejects.toBe(failure);
    expect(end).toHaveBeenCalledTimes(1);
    await connection.endAsync();
    await expect(controller.connect()).resolves.toBeUndefined();
    await controller.disconnect();
  });
});

describe("controller response deadlines during publication", () => {
  for (const operation of ["control", "state"] as const) {
    for (const failure of ["timeout", "rejection", "close"] as const) {
      it(`reports ${operation} ${failure} before publication settles`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { controller, entered, release, connections, published } =
          fixture("publish");
        let result: unknown;
        const pending = outcome(
          operation === "control"
            ? controller.setSoundLevel(50)
            : controller.getState(),
        ).then((value) => {
          result = value;
        });
        try {
          await entered.promise;
          if (failure === "timeout") {
            await vi.advanceTimersByTimeAsync(1_000);
          } else if (failure === "rejection") {
            const { topic, body } = published[0]!;
            connections[0]!.emit(
              "message",
              `${topic}/rejected`,
              Buffer.from(JSON.stringify(body)),
            );
          } else {
            connections[0]!.emit("close");
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(result).toMatchObject({
            error: {
              name: "CradlewiseRealtimeError",
              message:
                failure === "timeout"
                  ? "Crib control request timed out"
                  : failure === "close"
                    ? "Crib control connection closed"
                    : expect.stringContaining("rejected"),
            },
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          release.resolve();
          await controller.disconnect();
          await pending;
        }
      });
    }

    it(`still waits for publication after an accepted ${operation} response`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { controller, entered, release, connections, published } =
        fixture("publish");
      let settled = false;
      const pending = outcome(
        operation === "control"
          ? controller.setSoundLevel(50)
          : controller.getState(),
      ).then((value) => {
        settled = true;
        return value;
      });
      try {
        await entered.promise;
        const { topic, body } = published[0]!;
        connections[0]!.emit(
          "message",
          `${topic}/accepted`,
          Buffer.from(JSON.stringify(body)),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        release.resolve();
        expect(await pending).toHaveProperty("value");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release.resolve();
        await controller.disconnect();
      }
    });
  }

  it("advances queued controls after timeout and ignores the late response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { controller, entered, release, published } = fixture("publish");
    let firstResult: unknown;
    let secondResult: unknown;
    const first = outcome(controller.setSoundLevel(10)).then((value) => {
      firstResult = value;
    });
    const second = outcome(controller.setSoundLevel(50)).then((value) => {
      secondResult = value;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(firstResult).toMatchObject({
        error: { message: "Crib control request timed out" },
      });
      expect(secondResult).toMatchObject({ value: { soundLevel: 50 } });
      expect(published).toHaveLength(2);
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(controller.lock()).resolves.toMatchObject({
        soundLevel: 50,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
      await controller.disconnect();
      await Promise.all([first, second]);
    }
  });

  it("handles a late publication failure after delivering the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { controller, entered, release } = fixture("publish");
    let result: unknown;
    const pending = outcome(controller.setSoundLevel(10)).then((value) => {
      result = value;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result).toMatchObject({
        error: { message: "Crib control request timed out" },
      });
      const timeoutResult = result;
      release.reject(new Error("Late MQTT publication failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result).toBe(timeoutResult);
      await expect(controller.lock()).resolves.toMatchObject({ soundLevel: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
      await controller.disconnect();
      await pending;
    }
  });

  it("releases cancellation listeners when the publisher remains pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const subscriptions = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const { controller, entered, release } = fixture("publish");
    let result: unknown;
    const pending = outcome(controller.setSoundLevel(10)).then((value) => {
      result = value;
    });
    try {
      await entered.promise;
      const signals = new Set(
        subscriptions.mock.contexts.filter(
          (signal): signal is AbortSignal => signal instanceof AbortSignal,
        ),
      );
      expect(signals.size).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result).toMatchObject({
        error: { message: "Crib control request timed out" },
      });
      for (const signal of signals) {
        expect(getEventListeners(signal, "abort")).toHaveLength(0);
      }
    } finally {
      release.resolve();
      await controller.disconnect();
      await pending;
    }
  });

  for (const synchronous of [false, true]) {
    it(`cleans up after a ${synchronous ? "synchronous" : "rejected"} publish failure`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { controller, connections } = fixture();
      await controller.connect();
      const connection = connections[0]!;
      const failure = new Error("MQTT publication failed");
      const publish = vi.spyOn(connection, "publishAsync");
      if (synchronous) {
        publish.mockImplementationOnce((topic, payload) => {
          connection.emit("message", `${topic}/rejected`, Buffer.from(payload));
          throw failure;
        });
      } else {
        publish.mockRejectedValueOnce(failure);
      }
      try {
        await expect(controller.setSoundLevel(10)).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
        await expect(controller.lock()).resolves.toMatchObject({
          soundLevel: 0,
        });
        await vi.advanceTimersByTimeAsync(1_000);
      } finally {
        await controller.disconnect();
      }
    });
  }
});
