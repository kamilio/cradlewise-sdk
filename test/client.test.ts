import { describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { CradlewiseClient, formatApiDate } from "../src/client.js";
import type { CradlewiseApiError } from "../src/errors.js";
import { Cradle } from "../src/models.js";

function createAuth() {
  return {
    email: "parent@example.com",
    appConfig: new AppConfig({
      cognitoUserPoolId: "pool",
      cognitoAppClientId: "client",
      cognitoAppClientSecret: "secret",
      cognitoIdentityPoolId: "identity",
      cognitoRegion: "us-east-1",
      apiBaseUrl: "https://backend.cradlewise.com",
    }),
    credentials,
    clearCredentials: vi.fn(),
    authenticate: vi.fn(() => Promise.resolve(credentials)),
    ensureValid: vi.fn(() => Promise.resolve(credentials)),
  };
}

const credentials = {
  identityId: "identity",
  tokens: {
    accessToken: "access",
    idToken: "id",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  },
  aws: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
    expiration: new Date("2030-01-01T00:00:00Z"),
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-amzn-requestid": "request-1",
    },
  });
}

function userDevicesResponse(
  deviceIds = ["device-1"],
  email = "parent@example.com",
): Response {
  return jsonResponse({
    no_of_devices: deviceIds.length,
    user_devices: [
      {
        email_id: email,
        devices: deviceIds.map((device_id) => ({ device_id })),
      },
    ],
  });
}

describe("CradlewiseClient", () => {
  it("formats API dates and rejects invalid ranges", async () => {
    expect(formatApiDate(new Date("2026-01-02T03:04:05Z"))).toBe(
      "2026-01-02 03:04:05",
    );
    expect(formatApiDate("2026-01-02T03:04:05")).toBe("2026-01-02 03:04:05");
    expect(formatApiDate("2026-01-02 03:04:05.999999")).toBe(
      "2026-01-02 03:04:05",
    );
    expect(formatApiDate("2026-01-02")).toBe("2026-01-02 00:00:00");
    expect(formatApiDate("2026-01-02T03:04:05-06:00")).toBe(
      "2026-01-02 09:04:05",
    );
    const hostileDate = new Date("2026-01-02T03:04:05Z");
    hostileDate.getTime = () => 0;
    hostileDate.toISOString = () => {
      throw new Error("overridden toISOString");
    };
    expect(formatApiDate(hostileDate)).toBe("2026-01-02 03:04:05");
    expect(() => formatApiDate("not-a-date")).toThrow(RangeError);
    expect(() => formatApiDate("01/02/2026")).toThrow(RangeError);
    expect(() => formatApiDate("2026-02-29 00:00:00")).toThrow(RangeError);
    expect(() => formatApiDate("2026-02-29")).toThrow(RangeError);
    expect(() => formatApiDate("2".repeat(65))).toThrow(RangeError);
    expect(() => formatApiDate(1 as never)).toThrow(RangeError);
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>(),
    });
    await expect(
      client.getSleepEvents("baby", {
        startDate: "2026-01-02 00:00:00",
        endDate: "2026-01-01 00:00:00",
      }),
    ).rejects.toThrow("startDate");
  });

  it("validates the request timeout", () => {
    const auth = createAuth();
    expect(() => new CradlewiseClient(null as never)).toThrow(
      "CradlewiseAuth-compatible",
    );
    expect(() => new CradlewiseClient(auth as never, null as never)).toThrow(
      "options must be an object",
    );
    expect(
      () => new CradlewiseClient(auth as never, new Date() as never),
    ).toThrow("options must be an object");
    expect(
      () => new CradlewiseClient(auth as never, { fetch: 1 as never }),
    ).toThrow("fetch must be a function");
    expect(
      () =>
        new CradlewiseClient(auth as never, {
          userAgent: "client\ninjected",
        }),
    ).toThrow("printable ASCII");
    expect(
      () =>
        new CradlewiseClient(auth as never, {
          userAgent: " client ",
        }),
    ).toThrow("trimmed");
    expect(
      () =>
        new CradlewiseClient(auth as never, {
          userAgent: "cradlewise-👶",
        }),
    ).toThrow("printable ASCII");
    expect(
      () =>
        new CradlewiseClient(auth as never, {
          userAgent: "a".repeat(513),
        }),
    ).toThrow("printable ASCII");
    expect(
      () =>
        new CradlewiseClient(auth as never, {
          allowStateChangingRequests: "false" as never,
        }),
    ).toThrow("must be a boolean");
    const immutableClient = new CradlewiseClient(auth as never);
    expect(Reflect.set(immutableClient, "auth", {})).toBe(false);
    expect(immutableClient.auth).toBe(auth);
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          requestTimeoutMs: 0,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          maxResponseBytes: 0,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          maxResponseBytes: 1.5,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          maxResponseBytes: 64 * 1024 * 1024 + 1,
        }),
    ).toThrow("67108864");
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          requestTimeoutMs: 1.5,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseClient(createAuth() as never, {
          requestTimeoutMs: 2_147_483_648,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CradlewiseClient({
          ...createAuth(),
          appConfig: {
            apiBaseUrl: "https://example.com",
            cognitoRegion: "us-east-1",
          },
        } as never),
    ).toThrow("CradlewiseAuth-compatible");
    expect(
      () =>
        new CradlewiseClient({
          ...createAuth(),
          email: "parent@example.com\nignored",
        } as never),
    ).toThrow("CradlewiseAuth-compatible");
    expect(
      () =>
        new CradlewiseClient({
          ...createAuth(),
          email: `${"a".repeat(309)}@example.com`,
        } as never),
    ).toThrow("CradlewiseAuth-compatible");
  });

  it("snapshots a compatible auth adapter's signing boundary", async () => {
    const auth = createAuth();
    const mutableConfig = {
      apiBaseUrl: auth.appConfig.apiBaseUrl,
      cognitoRegion: auth.appConfig.cognitoRegion,
    };
    const mutableAuth = { ...auth, appConfig: mutableConfig };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = new CradlewiseClient(mutableAuth as never, {
      fetch: fetchMock,
    });
    mutableConfig.apiBaseUrl = "https://example.com";
    mutableConfig.cognitoRegion = "eu-west-1";
    mutableAuth.email = "different@example.com";

    await client.getBabyProfiles();

    const input = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1];
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).hostname).toBe("backend.cradlewise.com");
    expect((input as URL).searchParams.get("email_id")).toBe(
      "parent@example.com",
    );
    expect(new Headers(init?.headers).get("authorization")).toContain(
      "/us-east-1/execute-api/",
    );
  });

  it("reads compatible auth trust fields only once", async () => {
    const auth = createAuth();
    let configReads = 0;
    const rotatingAuth = { ...auth } as Record<string, unknown>;
    Object.defineProperty(rotatingAuth, "appConfig", {
      get: () => {
        configReads += 1;
        return configReads === 1
          ? auth.appConfig
          : {
              apiBaseUrl: "https://example.com",
              cognitoRegion: "eu-west-1",
            };
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = new CradlewiseClient(rotatingAuth as never, {
      fetch: fetchMock,
    });

    await client.getBabyProfiles();

    expect(configReads).toBe(1);
    expect((fetchMock.mock.calls[0]?.[0] as URL).hostname).toBe(
      "backend.cradlewise.com",
    );
  });

  it("snapshots compatible auth methods at construction", async () => {
    const auth = createAuth();
    const originalEnsureValid = auth.ensureValid;
    const originalAuthenticate = auth.authenticate;
    const mutableAuth = { ...auth };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CradlewiseClient(mutableAuth as never, {
      fetch: fetchMock,
    });
    mutableAuth.ensureValid = vi.fn(() =>
      Promise.reject(new Error("mutated ensureValid")),
    );
    mutableAuth.authenticate = vi.fn(() =>
      Promise.reject(new Error("mutated authenticate")),
    );

    await expect(client.request("GET", "/snapshot-auth")).resolves.toEqual({
      ok: true,
    });
    expect(originalEnsureValid).toHaveBeenCalledTimes(2);
    expect(originalAuthenticate).toHaveBeenCalledOnce();
    expect(mutableAuth.ensureValid).not.toHaveBeenCalled();
    expect(mutableAuth.authenticate).not.toHaveBeenCalled();
  });

  it("snapshots client constructor option getters once", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      fetch: fetchMock,
      userAgent: "test-agent/1",
      requestTimeoutMs: 1_000,
      maxResponseBytes: 1024,
      allowStateChangingRequests: false,
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }
    const client = new CradlewiseClient(createAuth() as never, options);

    await client.request("GET", "/snapshot-options");

    expect(Object.fromEntries(reads)).toEqual({
      fetch: 1,
      userAgent: 1,
      requestTimeoutMs: 1,
      maxResponseBytes: 1,
      allowStateChangingRequests: 1,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "user-agent": "test-agent/1",
    });
  });

  it("rejects malformed signing credentials from compatible auth adapters", async () => {
    const auth = createAuth();
    auth.ensureValid.mockResolvedValueOnce({
      ...credentials,
      aws: { ...credentials.aws, sessionToken: "" },
    });
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });

    await expect(client.request("GET", "/test")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      message:
        "Cradlewise authentication returned invalid AWS signing credentials",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    auth.ensureValid.mockResolvedValueOnce({
      ...credentials,
      aws: {
        ...credentials.aws,
        sessionToken: "x".repeat(128 * 1024 + 1),
      },
    });
    await expect(client.request("GET", "/test")).rejects.toThrow(
      "invalid AWS signing credentials",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots compatible signing credential fields once", async () => {
    const auth = createAuth();
    const reads = new Map<string, number>();
    const expiration = new Date(Date.now() + 60 * 60_000);
    expiration.getTime = () => {
      throw new Error("overridden getTime");
    };
    const values = {
      accessKeyId: "ACCESSKEY",
      secretAccessKey: "secret-access-key",
      sessionToken: "session-token",
      expiration,
    };
    const aws = Object.fromEntries(
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
    Object.defineProperties(credentialObject.aws, aws);
    auth.ensureValid.mockResolvedValueOnce(credentialObject as never);
    const client = new CradlewiseClient(auth as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ok: true })),
    });

    await expect(client.request("GET", "/snapshot")).resolves.toEqual({
      ok: true,
    });
    expect(Object.fromEntries(reads)).toEqual({
      accessKeyId: 1,
      secretAccessKey: 1,
      sessionToken: 1,
      expiration: 1,
    });
  });

  it("rejects malformed request inputs before authentication", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    await expect(client.request(" GET", "/test")).rejects.toThrow(TypeError);
    await expect(client.request("", "/test")).rejects.toThrow(TypeError);
    await expect(client.request("GET", "")).rejects.toThrow(TypeError);
    await expect(client.request("G".repeat(33), "/test")).rejects.toThrow(
      TypeError,
    );
    await expect(client.request("GET", `/${"a".repeat(8192)}`)).rejects.toThrow(
      "path",
    );
    await expect(client.request("GET", "/test#ignored")).rejects.toThrow(
      RangeError,
    );
    await expect(client.request("GET", "/test?ignored=1")).rejects.toThrow(
      "use options.query",
    );
    await expect(client.request("GET", "/../test")).rejects.toThrow(
      "dot segments",
    );
    await expect(client.request("GET", "/%2e%2e/test")).rejects.toThrow(
      "dot segments",
    );
    await expect(client.request("GET", "/.%2E/test")).rejects.toThrow(
      "dot segments",
    );
    await expect(client.request("GET", "/test%2Fnext")).rejects.toThrow(
      "separators",
    );
    await expect(client.request("GET", "/test%0anext")).rejects.toThrow(
      "encoded controls",
    );
    await expect(client.request("GET", "/%252e%252e/test")).rejects.toThrow(
      "percent signs",
    );
    await expect(client.request("GET", "/test%3Fquery")).rejects.toThrow(
      "encoded delimiters",
    );
    await expect(client.request("GET", "/test%23fragment")).rejects.toThrow(
      "encoded delimiters",
    );
    await expect(client.request("GET", "/test%zz")).rejects.toThrow(
      "malformed percent escapes",
    );
    await expect(client.request("GET", "/test%C2%85next")).rejects.toThrow(
      "encoded controls",
    );
    await expect(client.request("GET", "/test%FFnext")).rejects.toThrow(
      "valid UTF-8",
    );
    await expect(client.request("GET", "\\test")).rejects.toThrow(
      "backslashes",
    );
    await expect(client.request("GET", "/test\nnext")).rejects.toThrow(
      "controls",
    );
    await expect(client.request("GET", "/test\u0085next")).rejects.toThrow(
      "controls",
    );
    await expect(client.request("GET", "/test", null as never)).rejects.toThrow(
      "options must be an object",
    );
    await expect(
      client.request("GET", "/test", { query: [] as never }),
    ).rejects.toThrow("options.query must be an object");
    await expect(
      client.request("GET", "/test", { query: new Date() as never }),
    ).rejects.toThrow("options.query must be an object");
    await expect(
      client.request("GET", "/test", {
        query: { invalid: null as never },
      }),
    ).rejects.toThrow("must be a string, boolean, or finite number");
    await expect(
      client.request("GET", "/test", { query: { "": "value" } }),
    ).rejects.toThrow("parameter names");
    await expect(
      client.request("GET", "/test", { query: { " padded ": "value" } }),
    ).rejects.toThrow("parameter names");
    await expect(
      client.request("GET", "/test", {
        query: JSON.parse('{"__proto__":"value"}') as Record<string, string>,
      }),
    ).rejects.toThrow("parameter names");
    await expect(
      client.request("GET", "/test", { query: { value: "line\nbreak" } }),
    ).rejects.toThrow("control characters");
    await expect(
      client.request("GET", "/test", {
        query: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`key${index}`, index]),
        ),
      }),
    ).rejects.toThrow("100 parameters");
    await expect(
      client.request("GET", "/test", {
        query: { ["a".repeat(257)]: "value" },
      }),
    ).rejects.toThrow("parameter names");
    await expect(
      client.request("GET", "/test", {
        query: { value: "a".repeat(8193) },
      }),
    ).rejects.toThrow("8192 bytes");
    await expect(
      client.request("GET", "/test", {
        query: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `value${index}`,
            "a".repeat(8192),
          ]),
        ),
      }),
    ).rejects.toThrow("65536 encoded bytes");
    await expect(
      client.request("GET", "/test", { body: { unexpected: true } }),
    ).rejects.toThrow("must not include a body");
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bodies that JSON.stringify cannot represent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });
    await expect(
      client.request("POST", "/test", { body: () => undefined }),
    ).rejects.toThrow("not JSON-serializable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before authentication", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });

    await expect(
      client.request("POST", "/test", {
        body: "x".repeat(16 * 1024 * 1024),
      }),
    ).rejects.toThrow("request body exceeds the 16 MiB limit");
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates analytics query values before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    await expect(client.getAnalytics("baby", -1)).rejects.toThrow(RangeError);
    await expect(client.getAnalytics("baby", 23.5)).rejects.toThrow(RangeError);
    await expect(client.getAnalytics("baby", null as never)).rejects.toThrow(
      "plain object",
    );
    await expect(
      client.getSleepEventsData("baby", null as never),
    ).rejects.toThrow("plain object");
    await expect(
      client.getSleepEventsData("baby", { startDate: 1 as never }),
    ).rejects.toThrow("Date or string");
    await expect(
      client.getSleepEventsData("baby", { timezone: null as never }),
    ).rejects.toThrow("timezone must be a string");
    await expect(
      client.getAnalytics("baby", { startHour: null as never }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getAnalytics("baby", { metricName: " " }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getAnalytics("baby", { metricName: " app " }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getAnalytics("baby", { metricName: null as never }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getAnalytics("baby", { metricFilter: "" }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getAnalytics("baby", { metricName: "a".repeat(257) }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.getSleepEventsData("baby", { timezone: "a".repeat(256) }),
    ).rejects.toThrow("255 bytes");
    await expect(
      client.getAnalytics("baby", { timezone: "Not/A_Timezone" }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.fetchSleepAnalytics(new Cradle({ cradleId: "crib" }), {
        startHour: 24,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.fetchSleepAnalytics(
        new Cradle({ cradleId: "crib", babyId: "baby" }),
        { metricName: " " },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      client.fetchSleepAnalytics(
        new Cradle({ cradleId: "crib" }),
        null as never,
      ),
    ).rejects.toThrow("plain object");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots sleep analytics option getters once", async () => {
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      startDate: "2026-01-01 00:00:00",
      endDate: "2026-01-02 00:00:00",
      timezone: "UTC",
      startHour: 8,
      metricName: "sleep_metrics",
      metricFilter: "app",
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ total_sleep: 1 })),
    });

    await expect(
      client.getAnalytics("baby", options as never),
    ).resolves.toEqual({ total_sleep: 1 });
    expect(Object.fromEntries(reads)).toEqual({
      startDate: 1,
      endDate: 1,
      timezone: 1,
      startHour: 1,
      metricName: 1,
      metricFilter: 1,
    });
  });

  it("rejects malformed path identifiers before authentication", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    await expect(client.getCradleState(" ")).rejects.toThrow(RangeError);
    await expect(client.getCradleState("crib/other")).rejects.toThrow(
      "cradleId",
    );
    await expect(client.getCradleState("crib%2Fother")).rejects.toThrow(
      "cradleId",
    );
    await expect(client.getCradleState("crib?other")).rejects.toThrow(
      "cradleId",
    );
    await expect(client.getCradleState("crib\nother")).rejects.toThrow(
      "cradleId",
    );
    await expect(client.getCradleState("a".repeat(257))).rejects.toThrow(
      "cradleId",
    );
    await expect(client.getCradlesForBaby("..")).rejects.toThrow("babyId");
    await expect(client.getCradlesForBaby(Number.NaN)).rejects.toThrow(
      RangeError,
    );
    await expect(client.getCradlesForBaby(1.5)).rejects.toThrow(RangeError);
    await expect(client.getStatusTimeline("baby", "")).rejects.toThrow(
      RangeError,
    );
    await expect(client.updateCradle(null as never)).rejects.toThrow(
      "Cradle instance",
    );
    await expect(
      client.fetchSleepAnalytics({ babyId: "baby" } as never),
    ).rejects.toThrow("Cradle instance");
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discovers and updates cribs", async () => {
    const auth = createAuth();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ user_list: [{ baby_id: 12, name: "Baby" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          cradle_list: [{ cradle_id: "crib-1", timezone: "UTC" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ babyPresent: true }))
      .mockResolvedValueOnce(jsonResponse({ online: false }))
      .mockResolvedValueOnce(jsonResponse({ version: "1.2.3" }));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    const cradles = await client.discoverCradles();
    const cradle = cradles.get("crib-1")!;
    await client.updateCradle(cradle);

    expect(cradle.babyId).toBe("12");
    expect(cradle.babyPresent).toBe(true);
    expect(cradle.online).toBe(false);
    expect(cradle.firmwareVersion).toBe("1.2.3");
    expect(cradle.statusPartial).toBe(false);
    expect(cradle.unavailableStatusSources).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: expect.any(String),
    });
  });

  it("coalesces concurrent crib discovery", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ baby_id: "baby" }]))
      .mockResolvedValueOnce(jsonResponse([{ cradle_id: "crib" }]));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    const [first, second] = await Promise.all([
      client.discoverCradles(),
      client.discoverCradles(),
    ]);

    expect(first).toBe(second);
    expect(first.get("crib")?.babyId).toBe("baby");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds discovery follow-up request concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const profiles = Array.from({ length: 10 }, (_, index) => ({
      baby_id: `baby-${index}`,
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = input as URL;
      if (url.pathname.endsWith("/forEmail")) return jsonResponse(profiles);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse([]);
    });
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    await expect(client.discoverCradles()).resolves.toEqual(new Map());
    expect(maximumActive).toBe(8);
  });

  it("preserves existing crib models across discovery refreshes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([{ baby_id: "baby", name: "First name" }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ cradle_id: "crib", timezone: "UTC" }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ baby_id: "baby", name: "Updated name" }]),
      )
      .mockResolvedValueOnce(jsonResponse([{ cradle_id: "crib" }]));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    const first = (await client.discoverCradles()).get("crib");
    expect(first).toBeInstanceOf(Cradle);
    first?.updateState({ babyPresent: true });
    first!.online = true;

    const second = (await client.discoverCradles()).get("crib");
    expect(second).toBe(first);
    expect(second).toMatchObject({
      babyId: "baby",
      babyName: "Updated name",
      timezone: undefined,
      online: true,
      babyPresent: true,
    });
  });

  it("does not partially update existing cribs when discovery fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          { baby_id: "first", name: "Updated" },
          { baby_id: "second", name: "Invalid" },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ cradle_id: "crib", timezone: "America/Chicago" }]),
      )
      .mockResolvedValueOnce(jsonResponse([{ cradle_id: "../invalid" }]));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const existing = new Cradle({
      cradleId: "crib",
      babyId: "original",
      babyName: "Original",
      timezone: "UTC",
    });
    client.cradles.set("crib", existing);

    await expect(client.discoverCradles()).rejects.toThrow(
      "unexpected response",
    );

    expect(client.cradles.get("crib")).toBe(existing);
    expect(existing.babyId).toBe("original");
    expect(existing.babyName).toBe("Original");
    expect(existing.timezone).toBe("UTC");
  });

  it("replaces a crib cache entry stored under the wrong identifier", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse([{ baby_id: "baby" }]))
        .mockResolvedValueOnce(jsonResponse([{ cradle_id: "crib" }])),
    });
    const mismatched = new Cradle({ cradleId: "other" });
    client.cradles.set("crib", mismatched);

    const discovered = (await client.discoverCradles()).get("crib");
    expect(discovered).not.toBe(mismatched);
    expect(discovered?.cradleId).toBe("crib");
  });

  it("accepts nullable no-data fields from current API models", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ user_list: [{ baby_id: "baby", name: null }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          cradle_list: [{ cradle_id: "crib", timezone: null }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: null,
          timezone: null,
          sleep_sessions_saved: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [{ event_time: null, event_value: null }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sleep_sessions: null,
          awake_sessions: [{ date: null, value: null }],
          successful_bounce_count: null,
          auto_soothe_events: null,
          auto_soothe_counts: null,
          timezone: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ rootfs_version: null, serial_number: null }),
      );
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    const cradles = await client.discoverCradles();
    expect(cradles.get("crib")?.babyName).toBe("Baby");
    await expect(client.getSleepEventsData("baby")).resolves.toEqual({
      events: [],
    });
    await expect(client.getSleepEventsData("baby")).resolves.toMatchObject({
      events: [{ event_time: null, event_value: null }],
    });
    await expect(client.getAnalytics("baby")).resolves.toMatchObject({
      sleep_sessions: null,
      auto_soothe_counts: null,
    });
    await expect(client.getFirmwareData("crib")).resolves.toEqual({
      rootfs_version: null,
      serial_number: null,
    });
  });

  it("maps current online and firmware response fields", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ baby_present: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          state_message: JSON.stringify({ state: { state: 0 } }),
          state_message_time: "2026-01-01 00:00:00",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ rootfs_version: "5.48", serial_number: "serial" }),
      );
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = new Cradle({ cradleId: "crib" });

    await client.updateCradle(cradle);

    expect(cradle.babyPresent).toBe(false);
    expect(cradle.online).toBe(false);
    expect(cradle.firmwareVersion).toBe("5.48");
    expect(cradle.serialNumber).toBe("serial");
  });

  it("prevents older concurrent status reads from overwriting newer state", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const calls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const pathname = (input as URL).pathname;
      const count = (calls.get(pathname) ?? 0) + 1;
      calls.set(pathname, count);
      if (count === 1) {
        return new Promise<Response>((resolve) =>
          pending.set(pathname, resolve),
        );
      }
      if (pathname.endsWith("/state")) {
        return Promise.resolve(jsonResponse({ baby_present: true }));
      }
      if (pathname.endsWith("/onlineStatus/v2")) {
        return Promise.resolve(jsonResponse({ online: true }));
      }
      return Promise.resolve(jsonResponse({ rootfs_version: "new" }));
    });
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = new Cradle({ cradleId: "crib" });

    const older = client.updateCradle(cradle);
    await vi.waitFor(() => expect(pending.size).toBe(3));
    await client.updateCradle(cradle);
    for (const [pathname, resolve] of pending) {
      if (pathname.endsWith("/state")) {
        resolve(jsonResponse({ baby_present: false }));
      } else if (pathname.endsWith("/onlineStatus/v2")) {
        resolve(jsonResponse({ online: false }));
      } else {
        resolve(jsonResponse({ rootfs_version: "old" }));
      }
    }
    await older;

    expect(cradle.babyPresent).toBe(true);
    expect(cradle.online).toBe(true);
    expect(cradle.firmwareVersion).toBe("new");
    expect(cradle.statusPartial).toBe(false);
  });

  it("does not infer online state from cached state retrieval", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ baby_present: true }))
      .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ rootfs_version: "5.48" }));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = new Cradle({ cradleId: "crib", online: false });

    await client.updateCradle(cradle);

    expect(cradle.babyPresent).toBe(true);
    expect(cradle.online).toBe(false);
    expect(cradle.statusPartial).toBe(true);
    expect(cradle.unavailableStatusSources).toEqual(["online"]);
  });

  it("fails a crib update when every status source fails", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(jsonResponse({ message: "unavailable" }, 503)),
        ),
    });
    const cradle = new Cradle({ cradleId: "crib" });
    await expect(client.updateCradle(cradle)).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.any(AggregateError),
    });
    expect(cradle.statusPartial).toBe(true);
    expect(cradle.unavailableStatusSources).toEqual([
      "state",
      "online",
      "firmware",
    ]);
  });

  it("rejects malformed discovery and crib endpoint responses", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ user_list: "invalid" }))
        .mockResolvedValueOnce(jsonResponse({ cradle_list: "invalid" }))
        .mockImplementation(() => Promise.resolve(jsonResponse([]))),
    });
    await expect(client.getBabyProfiles()).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(client.getCradlesForBaby("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(client.getCradleState("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(client.getCradleOnlineStatus("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(client.getFirmwareData("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(
      client.getStatusTimeline("baby", "crib"),
    ).rejects.toMatchObject({ name: "CradlewiseApiError" });
  });

  it("rejects malformed known online and firmware fields", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ state_message: 1 }))
        .mockResolvedValueOnce(jsonResponse({ state_message: "not-json" }))
        .mockResolvedValueOnce(jsonResponse({ state_message: null }))
        .mockResolvedValueOnce(jsonResponse({ rootfs_version: false }))
        .mockResolvedValueOnce(jsonResponse({ rootfs_version: "bad\nvalue" })),
    });
    await expect(client.getCradleOnlineStatus("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { state_message: 1 },
    });
    await expect(client.getCradleOnlineStatus("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { state_message: "not-json" },
    });
    await expect(client.getCradleOnlineStatus("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { state_message: null },
    });
    await expect(client.getFirmwareData("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { rootfs_version: false },
    });
    await expect(client.getFirmwareData("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { rootfs_version: "bad\nvalue" },
    });
  });

  it("rejects malformed or excessive status timelines", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ status_list: [1] }))
        .mockResolvedValueOnce(
          jsonResponse({
            status_list: Array.from({ length: 100_001 }, () => ({})),
          }),
        ),
      maxResponseBytes: 32 * 1024 * 1024,
    });

    await expect(client.getStatusTimeline("baby", "crib")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getStatusTimeline("baby", "crib")).rejects.toThrow(
      "unexpected response",
    );
  });

  it("rejects unsafe embedded online-state JSON", async () => {
    const deeplyNested = `${"[".repeat(101)}0${"]".repeat(101)}`;
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ state_message: deeplyNested }))
        .mockResolvedValueOnce(
          jsonResponse({ state_message: "x".repeat(1024 * 1024 + 1) }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            online: true,
            state_message: "x".repeat(1024 * 1024 + 1),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ online: true, state_message_time: "bad\ntime" }),
        ),
      maxResponseBytes: 2 * 1024 * 1024,
    });

    await expect(client.getCradleOnlineStatus("crib")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getCradleOnlineStatus("crib")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getCradleOnlineStatus("crib")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getCradleOnlineStatus("crib")).rejects.toThrow(
      "unexpected response",
    );
  });

  it("rejects successful error envelopes from crib endpoints", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" })),
    });

    await expect(client.getCradleState("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
    await expect(client.getCradleOnlineStatus("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
    await expect(client.getFirmwareData("crib")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
    await expect(
      client.getStatusTimeline("baby", "crib"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
  });

  it("validates discovery entries and resolves duplicates deterministically", async () => {
    const malformed = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse([null]))
        .mockResolvedValueOnce(jsonResponse([{}])),
    });
    await expect(malformed.getBabyProfiles()).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(malformed.getCradlesForBaby("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });

    const wrongTypes = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse([{ baby_id: true }]))
        .mockResolvedValueOnce(
          jsonResponse([{ cradle_id: "crib", timezone: 123 }]),
        ),
    });
    await expect(wrongTypes.getBabyProfiles()).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });
    await expect(wrongTypes.getCradlesForBaby("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });

    const unsafeName = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse([{ baby_id: "baby", name: "bad\nname" }]),
        ),
    });
    await expect(unsafeName.getBabyProfiles()).rejects.toMatchObject({
      name: "CradlewiseApiError",
    });

    const oversized = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(
            Array.from({ length: 101 }, (_, index) => ({ baby_id: index })),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            Array.from({ length: 101 }, (_, index) => ({
              cradle_id: `crib-${index}`,
            })),
          ),
        ),
    });
    await expect(oversized.getBabyProfiles()).rejects.toThrow(
      "unexpected response",
    );
    await expect(oversized.getCradlesForBaby("baby")).rejects.toThrow(
      "unexpected response",
    );

    const excessiveUniqueCribs = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>((input) => {
        const url = input as URL;
        if (url.pathname.endsWith("/forEmail")) {
          return Promise.resolve(
            jsonResponse([{ baby_id: "first" }, { baby_id: "second" }]),
          );
        }
        const prefix = url.pathname.includes("/first/") ? "first" : "second";
        return Promise.resolve(
          jsonResponse(
            Array.from({ length: 51 }, (_, index) => ({
              cradle_id: `${prefix}-${index}`,
            })),
          ),
        );
      }),
    });
    await expect(excessiveUniqueCribs.discoverCradles()).rejects.toThrow(
      "more than 100 unique cribs",
    );

    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = input as URL;
      if (url.pathname.endsWith("/forEmail")) {
        return Promise.resolve(
          jsonResponse([
            { baby_id: "first", name: "First" },
            { baby_id: "second", name: "Second" },
          ]),
        );
      }
      const response = jsonResponse([{ cradle_id: "shared" }]);
      return url.pathname.includes("/first/")
        ? new Promise((resolve) => setTimeout(() => resolve(response), 10))
        : Promise.resolve(response);
    });
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = (await client.discoverCradles()).get("shared");
    expect(cradle?.babyId).toBe("first");
    expect(cradle?.babyName).toBe("First");
  });

  it("aggregates analytics and caches the result", async () => {
    const auth = createAuth();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          { event_time: "2026-01-01T00:00:00Z", event_value: 4 },
          { event_time: "2026-01-01T00:10:00Z", event_value: 1 },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ total_sleep: 10 }));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    const cradle = new Cradle({ cradleId: "crib", babyId: "baby" });
    const analytics = await client.fetchSleepAnalytics(cradle);
    expect(analytics.totalSleepMinutes).toBe(10);
    expect(client.analytics.get("baby")).toBe(analytics);
    const eventInput = fetchMock.mock.calls[0]![0];
    const analyticsInput = fetchMock.mock.calls[1]![0];
    expect(eventInput).toBeInstanceOf(URL);
    expect(analyticsInput).toBeInstanceOf(URL);
    const eventUrl = (eventInput as URL).href;
    const analyticsUrl = (analyticsInput as URL).href;
    expect(eventUrl).toContain("start_date=");
    expect(eventUrl).toContain("end_date=");
    expect(analyticsUrl).toContain("metric_name=sleep_metrics");
    expect(analyticsUrl).toContain("metric_filter=app");
    expect(analyticsUrl).toContain("start_hour=8");
  });

  it("prevents older analytics reads from replacing the newer cache", async () => {
    const pending: Array<(response: Response) => void> = [];
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      requestCount += 1;
      if (requestCount <= 2) {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      return Promise.resolve(
        (input as URL).pathname.endsWith("/eventsV3")
          ? jsonResponse([])
          : jsonResponse({ total_sleep: 20 }),
      );
    });
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = new Cradle({ cradleId: "crib", babyId: "baby" });

    const older = client.fetchSleepAnalytics(cradle);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const newer = await client.fetchSleepAnalytics(cradle);
    pending[0]!(jsonResponse([]));
    pending[1]!(jsonResponse({ total_sleep: 10 }));
    const olderResult = await older;

    expect(olderResult.totalSleepMinutes).toBe(10);
    expect(newer.totalSleepMinutes).toBe(20);
    expect(client.analytics.get("baby")).toBe(newer);
  });

  it("snapshots the analytics baby identifier during requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await gate;
        return jsonResponse({ events: [] });
      })
      .mockImplementationOnce(async () => {
        await gate;
        return jsonResponse({ total_sleep: 12 });
      });
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });
    const cradle = new Cradle({ cradleId: "crib", babyId: "baby-old" });

    const request = client.fetchSleepAnalytics(cradle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    cradle.babyId = "baby-new";
    release();

    await expect(request).resolves.toMatchObject({ totalSleepMinutes: 12 });
    expect(client.analytics.has("baby-old")).toBe(true);
    expect(client.analytics.has("baby-new")).toBe(false);
    expect(
      fetchMock.mock.calls.every(([input]) =>
        (input as URL).pathname.includes("/babyProfiles/baby-old/"),
      ),
    ).toBe(true);
  });

  it("unwraps the current eventsV3 response", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            events: [{ event_time: "2026-01-01 00:00:00", event_value: "4" }],
            sleep_sessions_saved: [],
            timezone: "UTC",
          }),
        ),
      ),
    });
    const response = await client.getSleepEventsData("baby", {
      startDate: "2026-01-01 00:00:00",
      endDate: "2026-01-02 00:00:00",
    });
    expect(response.events).toHaveLength(1);
    expect(response.timezone).toBe("UTC");
    await expect(
      client.getSleepEvents("baby", {
        startDate: "2026-01-01 00:00:00",
        endDate: "2026-01-02 00:00:00",
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects malformed sleep endpoint responses", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ events: "invalid" }))
        .mockResolvedValueOnce(jsonResponse({ events: [null] }))
        .mockResolvedValueOnce(
          jsonResponse({ events: [], timezone: "Not/A_Timezone" }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ events: [{ event_time: "not-a-time" }] }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ events: [], sleep_sessions_saved: ["not-a-time"] }),
        )
        .mockResolvedValueOnce(jsonResponse({ events: [{ event_value: 1.5 }] }))
        .mockResolvedValueOnce(
          jsonResponse({ events: [{ event_value: 4, soothe_count: -1 }] }),
        )
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          jsonResponse({ sleep_sessions: [{ value: [10, -1] }] }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ successful_bounce_count: [{ value: "1" }] }),
        )
        .mockResolvedValueOnce(jsonResponse({ auto_soothe_counts: 1.5 }))
        .mockResolvedValueOnce(
          jsonResponse({
            sleep_sessions: [{ date: "2026-02-29", value: [] }],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ timezone: "Not/A_Timezone" }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse({ total_sleep: -1 })),
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: "invalid" },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [null] },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [], timezone: "Not/A_Timezone" },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [{ event_time: "not-a-time" }] },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [], sleep_sessions_saved: ["not-a-time"] },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [{ event_value: 1.5 }] },
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { events: [{ event_value: 4, soothe_count: -1 }] },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: [],
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { sleep_sessions: [{ value: [10, -1] }] },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { successful_bounce_count: [{ value: "1" }] },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { auto_soothe_counts: 1.5 },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: {
        sleep_sessions: [{ date: "2026-02-29", value: [] }],
      },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { timezone: "Not/A_Timezone" },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: {},
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
    await expect(client.getAnalytics("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { total_sleep: -1 },
    });
  });

  it("bounds sleep response scalar and array inputs", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ events: [{ event_time: "2".repeat(65) }] }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ events: [{ event_value: "x".repeat(257) }] }),
        )
        .mockResolvedValueOnce(jsonResponse({ total_sleep: "1".repeat(65) }))
        .mockResolvedValueOnce(
          jsonResponse({
            events: Array.from({ length: 100_001 }, () => ({})),
          }),
        ),
      maxResponseBytes: 2 * 1024 * 1024,
    });

    await expect(client.getSleepEventsData("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getSleepEventsData("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getAnalytics("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getSleepEventsData("baby")).rejects.toThrow(
      "unexpected response",
    );
  });

  it("rejects successful error envelopes from eventsV3", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" })),
    });

    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: {},
    });
    await expect(client.getSleepEventsData("baby")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      responseBody: { message: "unavailable" },
    });
  });

  it("treats bare naive events as UTC regardless of display timezone", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse([{ event_time: "2026-03-08 02:30:00", event_value: 4 }]),
        ),
    });
    await expect(
      client.getSleepEventsData("baby", { timezone: "America/New_York" }),
    ).resolves.toMatchObject({
      events: [{ event_time: "2026-03-08 02:30:00", event_value: 4 }],
    });
  });

  it("fails aggregate analytics when both source endpoints fail", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: "unavailable" }, 503)),
    });
    await expect(
      client.fetchSleepAnalytics(
        new Cradle({ cradleId: "crib", babyId: "baby" }),
      ),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.any(AggregateError),
    });
  });

  it("rejects aggregate analytics without a baby profile", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });

    await expect(
      client.fetchSleepAnalytics(new Cradle({ cradleId: "crib" })),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      message: expect.stringContaining("without a baby profile ID"),
    });
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the requested range end for event-only analytics", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            events: [{ event_time: "2026-01-01T00:00:00Z", event_value: 4 }],
            sleep_sessions_saved: [
              "2026-01-01 00:10:00",
              "2026-01-01 00:20:00",
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503)),
    });
    const analytics = await client.fetchSleepAnalytics(
      new Cradle({ cradleId: "crib", babyId: "baby" }),
      {
        startDate: "2026-01-01 00:00:00",
        endDate: "2026-01-01 01:00:00",
      },
    );
    expect(analytics.totalSleepMinutes).toBe(60);
    expect(analytics.totalSootheCount).toBe(2);
    expect(analytics.longestNapMinutes).toBe(60);
    expect(analytics.partial).toBe(true);
    expect(analytics.unavailableSources).toEqual(["analytics"]);
  });

  it("clips event-only analytics to the requested range start", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            events: [
              { event_time: "2026-01-01T00:00:00Z", event_value: 4 },
              { event_time: "2026-01-01T02:00:00Z", event_value: 1 },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503)),
    });

    const analytics = await client.fetchSleepAnalytics(
      new Cradle({ cradleId: "crib", babyId: "baby" }),
      {
        startDate: "2026-01-01 01:00:00",
        endDate: "2026-01-01 03:00:00",
      },
    );

    expect(analytics.totalSleepMinutes).toBe(60);
    expect(analytics.totalAwakeMinutes).toBe(60);
  });

  it("uses server metrics when the event endpoint fails", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503))
        .mockResolvedValueOnce(jsonResponse({ total_sleep: 12 })),
    });
    await expect(
      client.fetchSleepAnalytics(
        new Cradle({ cradleId: "crib", babyId: "baby" }),
      ),
    ).resolves.toMatchObject({
      totalSleepMinutes: 12,
      events: [],
      partial: true,
      unavailableSources: ["events"],
    });
  });

  it("reauthenticates once after an authorization error", async () => {
    const auth = createAuth();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        status: 403,
        ok: false,
        headers: new Headers(),
        body: { cancel },
        text: () => Promise.resolve(""),
      } as never)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    await expect(client.request("GET", "/test")).resolves.toEqual({ ok: true });
    expect(auth.clearCredentials).not.toHaveBeenCalled();
    expect(auth.authenticate).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(
      fetchMock.mock.calls[1]?.[1]?.signal,
    );
  });

  it("coalesces concurrent authorization refreshes", async () => {
    const auth = createAuth();
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    auth.authenticate.mockImplementation(async () => {
      await refresh;
      return credentials;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 403))
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 403))
      .mockResolvedValueOnce(jsonResponse({ request: 1 }))
      .mockResolvedValueOnce(jsonResponse({ request: 2 }));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });

    const first = client.request("GET", "/first");
    const second = client.request("GET", "/second");
    await vi.waitFor(() => expect(auth.authenticate).toHaveBeenCalledOnce());
    resolveRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { request: 1 },
      { request: 2 },
    ]);
    expect(auth.authenticate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a stale authorization failure without refreshing again", async () => {
    const auth = createAuth();
    const refreshedCredentials = {
      ...credentials,
      aws: {
        ...credentials.aws,
        accessKeyId: "NEWACCESSKEY",
        sessionToken: "new-session-token",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        auth.credentials = refreshedCredentials;
        return Promise.resolve(
          jsonResponse({ message: "stale signature" }, 403),
        );
      })
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });

    await expect(client.request("GET", "/test")).resolves.toEqual({ ok: true });
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a contextual API error", async () => {
    const auth = createAuth();
    const client = new CradlewiseClient(auth as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: "bad" }, 500)),
    });
    await expect(client.request("GET", "/broken")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 500,
      requestId: "request-1",
    } satisfies Partial<CradlewiseApiError>);

    const unsafeBodyClient = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"value":1e400}', {
          status: 500,
          headers: { "x-amzn-requestid": "request-2" },
        }),
      ),
    });
    await expect(
      unsafeBodyClient.request("GET", "/broken"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 500,
      requestId: "request-2",
      responseBody: '{"value":1e400}',
      cause: expect.objectContaining({
        message: "JSON response contains a non-finite number",
      }),
    });
  });

  it("wraps transport errors in the package error hierarchy", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      requestTimeoutMs: 1234,
    });
    await expect(client.request("GET", "/offline")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: undefined,
      cause: expect.objectContaining({ message: "offline" }),
    });
  });

  it("wraps malformed custom fetch responses", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(null as never),
    });
    await expect(client.request("GET", "/malformed")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("Response-like object"),
      }),
    });
  });

  it("cancels malformed custom fetch responses with invalid status", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: Number.NaN,
        body: { cancel },
      } as never),
    });

    await expect(client.request("GET", "/malformed")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("Response-like object"),
      }),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects impossible statuses and inconsistent ok flags", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        status: 0,
        ok: false,
        headers: new Headers(),
        body: { cancel },
        text: () => Promise.resolve(""),
      } as never)
      .mockResolvedValueOnce({
        status: 500,
        ok: true,
        headers: new Headers(),
        body: { cancel },
        text: () => Promise.resolve(""),
      } as never);
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    await expect(client.request("GET", "/status-zero")).rejects.toThrow(
      "invalid fetch response",
    );
    await expect(client.request("GET", "/inconsistent")).rejects.toThrow(
      "invalid fetch response",
    );
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("contains malformed synchronous response cancellation", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        body: { cancel: () => undefined },
      } as never),
    });
    await expect(client.request("GET", "/malformed")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("Response-like object"),
      }),
    });
  });

  it("contains hostile response and header accessors", async () => {
    const responseWithHostileBody = {
      get status() {
        throw new Error("status getter failed");
      },
      get body() {
        throw new Error("body getter failed");
      },
    };
    const hostileResponseClient = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(responseWithHostileBody as never),
    });
    await expect(
      hostileResponseClient.request("GET", "/hostile-response"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("Response-like object"),
      }),
    });

    let headerReads = 0;
    const hostileHeadersClient = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: {
          get: () => {
            headerReads += 1;
            if (headerReads === 1) return null;
            throw new Error("header getter failed");
          },
        },
        body: null,
        text: () => Promise.resolve("{}"),
      } as never),
    });
    await expect(
      hostileHeadersClient.request("GET", "/hostile-headers"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      cause: expect.objectContaining({ message: "header getter failed" }),
    });
  });

  it("snapshots custom fetch response properties once", async () => {
    const reads = new Map<string, number>();
    const headers = {};
    Object.defineProperty(headers, "get", {
      enumerable: true,
      get: () => {
        reads.set("headerMethod", (reads.get("headerMethod") ?? 0) + 1);
        return (name: string) => {
          reads.set("headerCall", (reads.get("headerCall") ?? 0) + 1);
          return name === "x-amzn-requestid" ? "request-once" : null;
        };
      },
    });
    const response = {
      get status() {
        reads.set("status", (reads.get("status") ?? 0) + 1);
        return reads.get("status") === 1 ? 200 : 500;
      },
      get ok() {
        reads.set("ok", (reads.get("ok") ?? 0) + 1);
        return true;
      },
      get headers() {
        reads.set("headers", (reads.get("headers") ?? 0) + 1);
        return headers;
      },
      get body() {
        reads.set("body", (reads.get("body") ?? 0) + 1);
        return null;
      },
      get text() {
        reads.set("text", (reads.get("text") ?? 0) + 1);
        return () => Promise.resolve('{"ok":true}');
      },
    };
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response as never),
    });

    await expect(client.request("GET", "/snapshot")).resolves.toEqual({
      ok: true,
    });
    expect(Object.fromEntries(reads)).toEqual({
      status: 1,
      ok: 1,
      headers: 1,
      body: 1,
      text: 1,
      headerMethod: 1,
      headerCall: 2,
    });
  });

  it("rejects non-string custom response text", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: null,
        text: () => Promise.resolve(2_147_483_647),
      } as never),
    });

    await expect(client.request("GET", "/invalid-text")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: "Cradlewise API response text must be a string",
      }),
    });
  });

  it("bounds declared and streamed response bodies", async () => {
    const declared = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("oversized", {
          headers: { "content-length": "9" },
        }),
      ),
      maxResponseBytes: 8,
    });
    await expect(declared.request("GET", "/large")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("size limit"),
      }),
    });

    const streamed = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("12345"));
              controller.enqueue(new TextEncoder().encode("67890"));
              controller.close();
            },
          }),
        ),
      ),
      maxResponseBytes: 8,
    });
    await expect(streamed.request("GET", "/large")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: expect.stringContaining("size limit"),
      }),
    });

    const malformed = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => "-1" },
        body: null,
        text: () => Promise.resolve("{}"),
      } as never),
    });
    await expect(malformed.request("GET", "/bad-length")).rejects.toMatchObject(
      {
        name: "CradlewiseApiError",
        cause: expect.objectContaining({
          message: "Response content-length header is invalid",
        }),
      },
    );
  });

  it("rejects malformed UTF-8 in streamed response bodies", async () => {
    const cancel = vi.fn();
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.of(0xc3, 0x28));
            },
            cancel,
          }),
        ),
      ),
    });

    await expect(client.request("GET", "/invalid-utf8")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      message: expect.stringContaining("reading the response body"),
      cause: expect.objectContaining({ name: "TypeError" }),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces request timeouts when custom fetch adapters ignore signals", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
      requestTimeoutMs: 20,
    });

    await expect(client.request("GET", "/timeout")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      message: expect.stringContaining("before receiving a response"),
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
  });

  it("enforces request timeouts when compatible auth adapters stall", async () => {
    const auth = createAuth();
    auth.ensureValid.mockImplementationOnce(() => new Promise(() => undefined));
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, {
      fetch: fetchMock,
      requestTimeoutMs: 20,
    });

    await expect(client.request("GET", "/timeout")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      message: expect.stringContaining("acquiring credentials"),
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a stalled compatible authentication refresh", async () => {
    const auth = createAuth();
    auth.authenticate.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 403));
    const client = new CradlewiseClient(auth as never, {
      fetch: fetchMock,
      requestTimeoutMs: 20,
    });

    await expect(client.request("GET", "/timeout")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 403,
      message: expect.stringContaining("refreshing credentials"),
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels custom fetch responses that arrive after timeout", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
      requestTimeoutMs: 20,
    });
    const request = client.request("GET", "/timeout");
    await expect(request).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    const cancel = vi.fn(() => Promise.resolve());
    resolveFetch?.({ body: { cancel } } as never);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("enforces request timeouts while reading custom response bodies", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: null,
        text: () => new Promise<string>(() => undefined),
      } as never),
      requestTimeoutMs: 20,
    });

    await expect(client.request("GET", "/timeout")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      message: expect.stringContaining("reading the response body"),
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
  });

  it("cancels hanging custom response streams at the request deadline", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: () => new Promise(() => undefined),
            cancel,
            releaseLock,
          }),
        },
        text: () => Promise.resolve(""),
      } as never),
      requestTimeoutMs: 20,
    });

    await expect(client.request("GET", "/timeout")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("uses text fallback for cancellable non-streaming bodies", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: { cancel },
        text: () => Promise.resolve('{"ok":true}'),
      } as never),
    });

    await expect(client.request("GET", "/text-fallback")).resolves.toEqual({
      ok: true,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("snapshots custom response stream methods before reading", async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    let getReaderReads = 0;
    let readMethodReads = 0;
    let readCalls = 0;
    const releaseLock = vi.fn();
    const body = {
      get getReader() {
        getReaderReads += 1;
        if (getReaderReads > 1) throw new Error("getReader read twice");
        return () => ({
          get read() {
            readMethodReads += 1;
            if (readMethodReads > 1) throw new Error("read method read twice");
            return () =>
              Promise.resolve(
                readCalls++ === 0
                  ? { done: false, value: bytes }
                  : { done: true },
              );
          },
          cancel: () => Promise.resolve(),
          releaseLock,
        });
      },
      cancel: () => Promise.resolve(),
    };
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body,
        text: () => Promise.resolve(""),
      } as never),
    });

    await expect(client.request("GET", "/stream-snapshot")).resolves.toEqual({
      ok: true,
    });
    expect(getReaderReads).toBe(1);
    expect(readMethodReads).toBe(1);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("rejects malformed custom response stream chunks", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const releaseLock = vi.fn();
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: () => Promise.resolve({ done: false, value: "not-bytes" }),
            cancel,
            releaseLock,
          }),
          cancel: () => Promise.resolve(),
        },
        text: () => Promise.resolve(""),
      } as never),
    });

    await expect(
      client.request("GET", "/invalid-stream"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: "Cradlewise API response returned an invalid stream chunk",
      }),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("uses typed-array internal lengths for streamed size limits", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ value: "x".repeat(32) }),
    );
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    let reads = 0;
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: () =>
              Promise.resolve(
                reads++ === 0 ? { done: false, value: bytes } : { done: true },
              ),
            cancel: () => Promise.resolve(),
            releaseLock: () => undefined,
          }),
          cancel: () => Promise.resolve(),
        },
        text: () => Promise.resolve(""),
      } as never),
      maxResponseBytes: 16,
    });

    await expect(
      client.request("GET", "/shadowed-length"),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: "Cradlewise API response exceeds the size limit",
      }),
    });
  });

  it("decodes multibyte JSON split across response chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ value: "👶" }));
    const split = bytes.indexOf(0xf0) + 2;
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              controller.close();
            },
          }),
        ),
      ),
      maxResponseBytes: bytes.byteLength,
    });
    await expect(client.request("GET", "/unicode")).resolves.toEqual({
      value: "👶",
    });
  });

  it("joins many bounded response chunks without changing JSON", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ value: "x".repeat(4096) }),
    );
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        ),
      ),
      maxResponseBytes: bytes.byteLength,
    });
    await expect(client.request("GET", "/chunked")).resolves.toEqual({
      value: "x".repeat(4096),
    });
  });

  it("rejects excessive response chunk counts", async () => {
    let sent = 0;
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent === 8193) {
                controller.close();
                return;
              }
              sent += 1;
              controller.enqueue(Uint8Array.of(120));
            },
          }),
        ),
      ),
      maxResponseBytes: 16 * 1024,
    });
    await expect(client.request("GET", "/chunks")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: "Cradlewise API response has too many chunks",
      }),
    });
  });

  it("supports text and empty successful responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("plain text"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });
    await expect(client.request("GET", "/text")).resolves.toBe("plain text");
    await expect(client.request("DELETE", "/empty")).resolves.toBeUndefined();
  });

  it("rejects structurally unsafe parsed JSON responses", async () => {
    const deeplyNested = `${"[".repeat(101)}0${"]".repeat(101)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"value":1e400}'))
      .mockResolvedValueOnce(new Response(deeplyNested))
      .mockResolvedValueOnce(new Response(JSON.stringify("[".repeat(101))));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    await expect(client.request("GET", "/nonfinite")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      message: expect.stringContaining("invalid JSON data"),
      cause: expect.objectContaining({
        message: "JSON response contains a non-finite number",
      }),
    });
    await expect(client.request("GET", "/deep")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      message: expect.stringContaining("invalid JSON data"),
    });
    await expect(client.request("GET", "/string")).resolves.toBe(
      "[".repeat(101),
    );
  });

  it("encodes paths, query parameters, and JSON request bodies", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });
    await client.request("POST", "custom path", {
      query: { text: "a b", enabled: true, count: 2 },
      body: { value: "test" },
    });
    await client.request("GET", "/caf%C3%A9");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toContain("custom%20path");
    expect((url as URL).href).toContain("text=a+b");
    expect(init?.body).toBe('{"value":"test"}');
    expect(init?.redirect).toBe("error");
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toBe("/caf%C3%A9");
  });

  it("snapshots request query and body getters before use", async () => {
    let queryReads = 0;
    let queryValueReads = 0;
    const query = {} as Record<string, unknown>;
    Object.defineProperty(query, "value", {
      enumerable: true,
      get: () => {
        queryValueReads += 1;
        return queryValueReads === 1 ? "safe" : "bad\nvalue";
      },
    });
    const getOptions = {} as Record<string, unknown>;
    Object.defineProperty(getOptions, "query", {
      enumerable: true,
      get: () => {
        queryReads += 1;
        return queryReads === 1 ? query : { value: "bad\nvalue" };
      },
    });
    let bodyReads = 0;
    const postOptions = {} as Record<string, unknown>;
    Object.defineProperty(postOptions, "body", {
      enumerable: true,
      get: () => {
        bodyReads += 1;
        return bodyReads === 1 ? { safe: true } : 1n;
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });

    await client.request("GET", "/query", getOptions);
    await client.request("POST", "/body", postOptions);

    expect(queryReads).toBe(1);
    expect(queryValueReads).toBe(1);
    expect(
      (fetchMock.mock.calls[0]?.[0] as URL).searchParams.get("value"),
    ).toBe("safe");
    expect(bodyReads).toBe(1);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"safe":true}');
  });

  it("rejects invalid query numbers and unserializable bodies", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });
    await expect(
      client.request("GET", "/query", { query: { value: Number.NaN } }),
    ).rejects.toThrow(TypeError);

    const body: Record<string, unknown> = {};
    body.self = body;
    await expect(
      client.request("POST", "/body", { body }),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.any(TypeError),
    });
    await expect(
      client.request("POST", "/body", { body: { value: Number.NaN } }),
    ).rejects.toMatchObject({
      name: "CradlewiseApiError",
      cause: expect.objectContaining({
        message: "request body contains a non-finite number",
      }),
    });
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks state-changing methods by default", async () => {
    const auth = createAuth();
    const fetchMock = vi.fn<typeof fetch>();
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    await expect(
      client.request("POST", "/unsafe", { body: {} }),
    ).rejects.toThrow("disabled by the read-only client boundary");
    await expect(client.request("DELETE", "/unsafe")).rejects.toThrow(
      "disabled by the read-only client boundary",
    );
    expect(auth.ensureValid).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never replays opted-in state-changing requests after auth errors", async () => {
    const auth = createAuth();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "forbidden" }, 403));
    const client = new CradlewiseClient(auth as never, {
      fetch: fetchMock,
      allowStateChangingRequests: true,
    });
    await expect(
      client.request("POST", "/research", { body: { value: 1 } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.clearCredentials).not.toHaveBeenCalled();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("wraps response body read failures", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => Promise.reject(new Error("stream failed")),
      } as never),
    });
    await expect(client.request("GET", "/stream")).rejects.toMatchObject({
      name: "CradlewiseApiError",
      status: 200,
      cause: expect.objectContaining({ message: "stream failed" }),
    });
  });

  it("does not retry authorization failures more than once", async () => {
    const auth = createAuth();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "forbidden" }, 403));
    const client = new CradlewiseClient(auth as never, { fetch: fetchMock });
    await expect(client.request("GET", "/forbidden")).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.authenticate).toHaveBeenCalledOnce();
  });

  it("reads the inbox and selects the latest usable crib photo", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(userDevicesResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          baby_notifications: [
            {
              message_id: 42,
              message_time: "2026-07-05T12:00:00Z",
              title: "A sleepy moment",
              content_type: "video",
              content_url: "https://private.cradlewise.com/video.mp4",
              thumbnail_url: "https://private.cradlewise.com/thumb.jpg",
              presentation_image_url:
                "https://private.cradlewise.com/presentation.jpg",
            },
          ],
          cradlewise_notifications: [],
        }),
      );
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    await expect(
      client.getLatestCribPhoto("crib-1", "baby-1"),
    ).resolves.toEqual({
      url: "https://private.cradlewise.com/presentation.jpg",
      messageId: 42,
      messageTime: "2026-07-05T12:00:00Z",
      title: "A sleepy moment",
      contentType: "video",
    });
    const devicesUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(devicesUrl.pathname).toBe("/babyProfiles/baby-1/userDevices");
    expect(Object.fromEntries(devicesUrl.searchParams)).toEqual({
      email_id: "parent@example.com",
    });
    const url = fetchMock.mock.calls[1]?.[0] as URL;
    expect(url.pathname).toBe("/inbox/v2");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      device_id: "device-1",
      page_size: "50",
      tags: "baby",
      baby_id: "baby-1",
      message_type: "baby",
      cradle_id: "crib-1",
    });
  });

  it("falls back to image content and rejects malformed inbox responses", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(
          jsonResponse({
            baby_notifications: [
              {
                content_type: "video",
                content_url: "https://private.cradlewise.com/video.mp4",
              },
              {
                content_type: "image",
                content_url: "https://private.cradlewise.com/photo.jpg",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(
          jsonResponse({ baby_notifications: [{ content_url: 1 }] }),
        ),
    });

    await expect(client.getLatestCribPhoto("crib", "baby")).resolves.toEqual({
      url: "https://private.cradlewise.com/photo.jpg",
      contentType: "image",
    });
    await expect(client.getInboxMessages("crib", "baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getInboxMessages("crib", "baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getInboxMessages("crib", "baby", 0)).rejects.toThrow(
      "pageSize",
    );
  });

  it("accepts a recognized empty inbox envelope", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(
          jsonResponse({
            enable_red_dot: false,
            all_tags: [],
            eol_message: null,
          }),
        ),
    });

    await expect(client.getLatestCribPhoto("crib", "baby")).resolves.toBe(
      undefined,
    );
  });

  it("rejects malformed empty inbox envelope fields", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(jsonResponse({ enable_red_dot: "false" }))
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(jsonResponse({ all_tags: ["baby", 1] }))
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(jsonResponse({ eol_message: { text: "done" } })),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.getInboxMessages("crib", "baby")).rejects.toThrow(
        "unexpected response",
      );
    }
  });

  it("selects the newest timestamped crib photo deterministically", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(userDevicesResponse())
        .mockResolvedValueOnce(
          jsonResponse({
            baby_notifications: [
              {
                message_id: 1,
                message_time: "2026-07-04T12:00:00Z",
                content_type: "image",
                content_url: "https://private.cradlewise.com/older.jpg",
              },
              {
                message_id: 2,
                message_time: "not-a-time",
                thumbnail_url: "https://private.cradlewise.com/unknown.jpg",
              },
              {
                message_id: 3,
                message_time: "2026-07-05T12:00:00Z",
                thumbnail_url: "https://private.cradlewise.com/newer.jpg",
              },
            ],
          }),
        ),
    });

    await expect(client.getLatestCribPhoto("crib", "baby")).resolves.toEqual({
      url: "https://private.cradlewise.com/newer.jpg",
      messageId: 3,
      messageTime: "2026-07-05T12:00:00Z",
    });
  });

  it("prefers recent signed-in user devices and retries explicitly stale IDs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          no_of_devices: -1,
          user_devices: [
            {
              email_id: "caregiver@example.com",
              devices: [{ device_id: "other-device" }],
            },
            {
              email_id: "PARENT@example.com",
              devices: [
                { device_id: "stale-device", last_connected_time: 10 },
                { device_id: "active-device", last_connected_time: 20 },
                { device_id: "active-device", last_connected_time: 30 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { errorType: "API_FAILED", message: "device_id is invalid." },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ baby_notifications: [], cradlewise_notifications: [] }),
      );
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: fetchMock,
    });

    await expect(client.getUserDeviceIds("baby")).resolves.toEqual([
      "active-device",
      "stale-device",
    ]);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          no_of_devices: 2,
          user_devices: [
            {
              email_id: "parent@example.com",
              devices: [
                { device_id: "stale-device", last_connected_time: 30 },
                { device_id: "active-device", last_connected_time: 20 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { errorType: "API_FAILED", message: "device_id is invalid." },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ baby_notifications: [], cradlewise_notifications: [] }),
      );

    await expect(client.getInboxMessages("crib", "baby")).resolves.toEqual({
      baby_notifications: [],
      cradlewise_notifications: [],
    });
    expect(
      (fetchMock.mock.calls[1]?.[0] as URL).searchParams.get("device_id"),
    ).toBe("stale-device");
    expect(
      (fetchMock.mock.calls[2]?.[0] as URL).searchParams.get("device_id"),
    ).toBe("active-device");
  });

  it("preserves registered-device service order without connection times", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          no_of_devices: -1,
          user_devices: [
            {
              email_id: "parent@example.com",
              devices: [
                { device_id: "first-device" },
                { device_id: "second-device", last_connected_time: null },
                { device_id: "first-device" },
              ],
            },
          ],
        }),
      ),
    });

    await expect(client.getUserDeviceIds("baby")).resolves.toEqual([
      "first-device",
      "second-device",
    ]);
  });

  it("rejects malformed or unavailable registered-device data", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ user_devices: "invalid" }))
        .mockResolvedValueOnce(
          jsonResponse({ no_of_devices: 101, user_devices: [] }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }))
        .mockResolvedValueOnce(userDevicesResponse([], "parent@example.com")),
    });

    await expect(client.getUserDeviceIds("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getUserDeviceIds("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getUserDeviceIds("baby")).rejects.toThrow(
      "unexpected response",
    );
    await expect(client.getInboxMessages("crib", "baby")).rejects.toThrow(
      "No registered Cradlewise app device",
    );
  });

  it("treats null or omitted registered-device lists as empty", async () => {
    const client = new CradlewiseClient(createAuth() as never, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ no_of_devices: 0, user_devices: null }),
        )
        .mockResolvedValueOnce(jsonResponse({ no_of_devices: 0 }))
        .mockResolvedValueOnce(jsonResponse({ user_devices: null })),
    });

    await expect(client.getUserDeviceIds("baby")).resolves.toEqual([]);
    await expect(client.getUserDeviceIds("baby")).resolves.toEqual([]);
    await expect(client.getInboxMessages("crib", "baby")).rejects.toThrow(
      "No registered Cradlewise app device",
    );
  });
});
