import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { CradlewiseController } from "../src/controls.js";
import { Cradle } from "../src/models.js";

const controllers: CradlewiseController[] = [];

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected application request"),
  );
});

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.disconnect()),
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function createHarness(
  options: {
    rejectFirst?: boolean;
    respond?: boolean;
    response?: (
      topic: string,
      body: Record<string, unknown>,
    ) => Record<string, unknown>;
  } = {},
) {
  const events = new EventEmitter();
  const published: Array<{ topic: string; body: Record<string, unknown> }> = [];
  let pendingResponses = 0;
  let maximumPendingResponses = 0;
  let responseCount = 0;
  const connection = {
    connected: true,
    subscribeAsync: vi.fn(() => Promise.resolve(undefined)),
    unsubscribeAsync: vi.fn(() => Promise.resolve(undefined)),
    publishAsync: vi.fn((topic: string, payload: string) => {
      const body = JSON.parse(payload) as Record<string, unknown>;
      published.push({ topic, body });
      if (options.respond !== false) {
        pendingResponses += 1;
        maximumPendingResponses = Math.max(
          maximumPendingResponses,
          pendingResponses,
        );
        queueMicrotask(() => {
          pendingResponses -= 1;
          responseCount += 1;
          events.emit(
            "message",
            `${topic}/${options.rejectFirst && responseCount === 1 ? "rejected" : "accepted"}`,
            Buffer.from(
              JSON.stringify({
                clientToken: body.clientToken,
                ...options.response?.(topic, body),
              }),
            ),
          );
        });
      }
      return Promise.resolve(undefined);
    }),
    on(event: "message", listener: (topic: string, payload: Buffer) => void) {
      events.on(event, listener);
      return this;
    },
    off(event: "message", listener: (topic: string, payload: Buffer) => void) {
      events.off(event, listener);
      return this;
    },
    once(event: "close", listener: () => void) {
      events.once(event, listener);
      return this;
    },
    endAsync: vi.fn(() => {
      connection.connected = false;
      events.emit("close");
      return Promise.resolve(undefined);
    }),
  };
  const config = new AppConfig({
    cognitoUserPoolId: "pool",
    cognitoAppClientId: "client",
    cognitoAppClientSecret: "secret",
    cognitoIdentityPoolId: "identity",
    cognitoRegion: "us-east-1",
    apiBaseUrl: "https://backend.cradlewise.com",
    iotEndpoint: "endpoint-ats.iot.us-east-1.amazonaws.com",
  });
  const credentials = {
    aws: {
      accessKeyId: "access",
      secretAccessKey: "secret",
      sessionToken: "session",
      expiration: new Date(Date.now() + 60_000),
    },
    tokens: {
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
  const auth = {
    appConfig: config,
    email: "parent@example.com",
    ensureValid: vi.fn(() => Promise.resolve(credentials)),
    authenticate: vi.fn(() => Promise.resolve(credentials)),
  };
  const fetchMock: typeof fetch = (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/cradles/pairedUsers/v3")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_config: {
              cradle_id: "crib-1",
              device_id: "device-1",
              s3_bucket: "bucket",
              s3_object_keys: ["certificate.pem", "private-key.pem"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes(".s3.us-east-1.amazonaws.com/")) {
      return Promise.resolve(
        new Response(url.includes("certificate") ? "CERT" : "KEY", {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };
  const controller = new CradlewiseController(
    auth as never,
    new Cradle({ cradleId: "crib-1", babyId: "123" }),
    {
      fetch: fetchMock,
      mqttConnect: vi.fn(() => Promise.resolve(connection)),
      operationTimeoutMs: 1_000,
    },
  );
  controllers.push(controller);
  return {
    controller,
    connection,
    events,
    published,
    maximumPendingResponses: () => maximumPendingResponses,
  };
}

describe("CradlewiseController controls", () => {
  it("uses one persistent response subscription for concurrent updates", async () => {
    const { controller, connection, published, maximumPendingResponses } =
      createHarness();

    const states = await Promise.all(
      [1, 2, 3, 4, 5].map((level) => controller.setBounceIntensityLevel(level)),
    );

    expect(states.map((state) => state.bounceIntensityLevel)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(connection.subscribeAsync).toHaveBeenCalledTimes(1);
    expect(connection.unsubscribeAsync).not.toHaveBeenCalled();
    expect(published).toHaveLength(5);
    expect(maximumPendingResponses()).toBe(1);
    expect(
      published.every(({ topic }) => topic.endsWith("/shadow/update")),
    ).toBe(true);
    expect(
      published.map(
        ({ body }) =>
          (body.state as { desired: { bounceLevel: number } }).desired
            .bounceLevel,
      ),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs start, stop, lock, and unlock as single-round-trip updates", async () => {
    const { controller, connection, published } = createHarness();

    await controller.startSoothingLevels({
      bounceLevel: 3,
      soundLevel: 2,
      lockMinutes: 15,
    });
    await controller.stop();
    await controller.lock(20);
    await controller.unlock();

    expect(connection.subscribeAsync).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(4);
    expect(
      published.every(({ topic }) => topic.endsWith("/shadow/update")),
    ).toBe(true);
    expect(published.map(({ body }) => body.state)).toEqual([
      {
        desired: {
          bounceLevel: 2,
          musicLevel: 1,
          soundSynth: { play: true },
          autoModeLockOn: true,
          autoModeLockDuration: 15,
        },
      },
      { desired: { actuator: { on: false }, soundSynth: { play: false } } },
      { desired: { autoModeLockDuration: 20, autoModeLockOn: true } },
      { desired: { autoModeLockOn: false } },
    ]);
  });

  it("rejects pending requests immediately when the connection closes", async () => {
    const { controller, events } = createHarness({ respond: false });
    const pending = controller.setMaxBouncePercent(80);
    await vi.waitFor(() => expect(events.listenerCount("message")).toBe(1));

    events.emit("close");

    await expect(pending).rejects.toThrow("connection closed");
  });

  it("continues queued updates after an earlier request is rejected", async () => {
    const { controller, published } = createHarness({ rejectFirst: true });

    const first = controller.setBounceIntensityLevel(1);
    const second = controller.setBounceIntensityLevel(5);

    await expect(first).rejects.toThrow("rejected the control request");
    await expect(second).resolves.toMatchObject({ bounceIntensityLevel: 5 });
    expect(published).toHaveLength(2);
  });
});

function reportedState(active: boolean) {
  return {
    actuator: { on: active, amplitude: 30 },
    soundSynth: { play: active, volume: 40 },
    bounceLevel: 2,
    musicLevel: 1,
    maxBounceLimit: 70,
    maxVolumeLimit: 80,
    autoModeLockOn: false,
    autoModeLockDuration: 30,
  };
}

describe("control result observations", () => {
  for (const duration of [15, 0, "15"]) {
    it(`retains only valid observed lock durations while unlocking: ${JSON.stringify(duration)}`, async () => {
      const { controller } = createHarness({
        response: () => ({
          state: {
            reported: { autoModeLockOn: true, autoModeLockDuration: duration },
          },
        }),
      });
      await expect(controller.unlock()).resolves.toEqual({
        locked: false,
        ...(duration === 15 ? { lockMinutes: 15 } : {}),
      });
    });
  }
  for (const preloaded of [undefined, true, false]) {
    it(`uses accepted reported fields instead of ${String(preloaded)} cached activity`, async () => {
      const active = preloaded !== true;
      const { controller, published } = createHarness({
        response: (topic) => ({
          version: topic.endsWith("/get") ? 3 : 4,
          state: {
            reported: reportedState(
              topic.endsWith("/get") ? preloaded === true : active,
            ),
          },
        }),
      });
      if (preloaded !== undefined) await controller.getState();
      await expect(controller.lock(15)).resolves.toEqual({
        active,
        bounceOn: active,
        soundOn: active,
        bounceLevel: 30,
        soundLevel: 40,
        bounceIntensityLevel: 3,
        soundIntensityLevel: 2,
        maxBouncePercent: 70,
        maxSoundPercent: 80,
        locked: true,
        lockMinutes: 15,
        shadowVersion: 4,
      });
      expect(
        published.filter(({ topic }) => topic.endsWith("/update")),
      ).toHaveLength(1);
      expect(published.at(-1)?.body.state).toEqual({
        desired: { autoModeLockDuration: 15, autoModeLockOn: true },
      });
    });
  }

  const narrowOperations: Array<
    [string, (controller: CradlewiseController) => Promise<unknown>, object]
  > = [
    [
      "lock",
      (controller) => controller.lock(15),
      { locked: true, lockMinutes: 15 },
    ],
    ["unlock", (controller) => controller.unlock(), { locked: false }],
    [
      "max bounce",
      (controller) => controller.setMaxBouncePercent(70),
      { maxBouncePercent: 70 },
    ],
    [
      "max sound",
      (controller) => controller.setMaxSoundPercent(80),
      { maxSoundPercent: 80 },
    ],
  ];
  for (const [name, operation, expected] of narrowOperations) {
    for (const shape of ["absent", "desired", "empty reported"]) {
      it(`${name} omits unknown fields with ${shape} response state`, async () => {
        const { controller } = createHarness({
          response: (_topic, body) => ({
            version: 7,
            ...(shape === "desired"
              ? { state: body.state }
              : shape === "empty reported"
                ? { state: { reported: {} } }
                : {}),
          }),
        });
        await expect(operation(controller)).resolves.toEqual({
          ...expected,
          shadowVersion: 7,
        });
      });
    }
  }

  it("does not carry a previous observation or optimistic command into a lock-only result", async () => {
    const { controller } = createHarness({
      response: (topic) =>
        topic.endsWith("/get")
          ? { state: { reported: reportedState(true) } }
          : {},
    });
    await expect(controller.getState()).resolves.toMatchObject({
      active: true,
      soundLevel: 40,
    });
    await controller.setSoundLevel(90);
    await expect(controller.lock(15)).resolves.toEqual({
      locked: true,
      lockMinutes: 15,
    });
  });

  const partialObservations: Array<[string, object, object]> = [
    [
      "sound on",
      { soundSynth: { play: true, volume: 40 } },
      { active: true, soundOn: true, soundLevel: 40 },
    ],
    ["sound off alone", { soundSynth: { play: false } }, { soundOn: false }],
    [
      "both off",
      { actuator: { on: false }, soundSynth: { play: false } },
      { active: false, bounceOn: false, soundOn: false },
    ],
    [
      "zero and upper limits",
      {
        actuator: { amplitude: 0 },
        soundSynth: { volume: 99 },
        bounceLevel: 0,
        musicLevel: 4,
        maxBounceLimit: 0,
        maxVolumeLimit: 100,
      },
      {
        bounceLevel: 0,
        soundLevel: 99,
        bounceIntensityLevel: 1,
        soundIntensityLevel: 5,
        maxBouncePercent: 0,
        maxSoundPercent: 100,
      },
    ],
    [
      "invalid fields",
      {
        actuator: { on: "false", amplitude: -1 },
        soundSynth: { play: null, volume: 100 },
        bounceLevel: 5,
        musicLevel: -1,
        maxBounceLimit: 101,
        maxVolumeLimit: null,
      },
      {},
    ],
  ];
  for (const [name, reported, expected] of partialObservations) {
    it(`retains only supplied valid observations: ${name}`, async () => {
      const { controller } = createHarness({
        response: () => ({ state: { reported } }),
      });
      await expect(controller.lock(15)).resolves.toEqual({
        ...expected,
        locked: true,
        lockMinutes: 15,
      });
    });
  }

  const levelOperations: Array<
    [string, (controller: CradlewiseController) => Promise<unknown>, object]
  > = [
    [
      "bounce off",
      (controller) => controller.setBounceLevel(0),
      { bounceOn: false, bounceLevel: 0 },
    ],
    [
      "sound off",
      (controller) => controller.setSoundLevel(0),
      { soundOn: false, soundLevel: 0 },
    ],
    [
      "bounce intensity off",
      (controller) => controller.setBounceIntensityLevel(0),
      { bounceOn: false, bounceIntensityLevel: 0 },
    ],
    [
      "sound intensity off",
      (controller) => controller.setSoundIntensityLevel(0),
      { soundOn: false, soundIntensityLevel: 0 },
    ],
    [
      "bounce on",
      (controller) => controller.setBounceLevel(30),
      { active: true, bounceOn: true, bounceLevel: 30 },
    ],
    [
      "sound on",
      (controller) => controller.setSoundLevel(40),
      { active: true, soundOn: true, soundLevel: 40 },
    ],
    [
      "bounce intensity on",
      (controller) => controller.setBounceIntensityLevel(3),
      { active: true, bounceOn: true, bounceIntensityLevel: 3 },
    ],
    [
      "sound intensity on",
      (controller) => controller.setSoundIntensityLevel(2),
      { active: true, soundOn: true, soundIntensityLevel: 2 },
    ],
    [
      "stop",
      (controller) => controller.stop(),
      { active: false, bounceOn: false, soundOn: false },
    ],
    [
      "start",
      (controller) =>
        controller.startSoothing({ bounceLevel: 30, soundLevel: 40 }),
      {
        active: true,
        bounceOn: true,
        bounceLevel: 30,
        soundOn: true,
        soundLevel: 40,
        locked: false,
      },
    ],
    [
      "start intensity",
      (controller) =>
        controller.startSoothingLevels({ bounceLevel: 3, soundLevel: 0 }),
      {
        active: true,
        bounceOn: true,
        bounceIntensityLevel: 3,
        soundOn: false,
        soundIntensityLevel: 0,
        locked: false,
      },
    ],
  ];
  for (const [name, operation, expected] of levelOperations) {
    it(`projects ${name} without inventing untouched state`, async () => {
      await expect(operation(createHarness().controller)).resolves.toEqual(
        expected,
      );
    });
  }

  it("derives activity from untouched reported fields and the acknowledged change", async () => {
    const { controller } = createHarness({
      response: () => ({ state: { reported: reportedState(true) } }),
    });
    await expect(controller.setSoundLevel(0)).resolves.toMatchObject({
      active: true,
      bounceOn: true,
      soundOn: false,
      soundLevel: 0,
    });
    await expect(controller.stop()).resolves.toMatchObject({
      active: false,
      bounceOn: false,
      soundOn: false,
    });
  });
});
