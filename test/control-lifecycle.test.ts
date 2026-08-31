import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { CradlewiseController } from "../src/controls.js";
import { Cradle } from "../src/models.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

afterEach(() => vi.restoreAllMocks());

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
