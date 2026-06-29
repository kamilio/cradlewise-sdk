import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { CradlewiseController } from "../src/controls.js";
import { Cradle } from "../src/models.js";

function createHarness(
  options: { rejectFirst?: boolean; respond?: boolean } = {},
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
            Buffer.from(JSON.stringify({ clientToken: body.clientToken })),
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
