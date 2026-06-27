import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSDK } from "toolcraft/sdk";
import type * as ConfigModule from "../src/config.js";

const mocks = vi.hoisted(() => ({
  getAppConfig: vi.fn(),
  refreshAppConfig: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof ConfigModule>();
  return {
    ...original,
    getAppConfig: mocks.getAppConfig,
    refreshAppConfig: mocks.refreshAppConfig,
  };
});

import { AppConfig } from "../src/config.js";
import { CradlewiseClient } from "../src/client.js";
import { Cradle } from "../src/models.js";
import { cradlewiseToolcraftRoot } from "../src/toolcraft.js";

describe("Toolcraft commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches the documented SDK command surface", () => {
    const sdk = createSDK(cradlewiseToolcraftRoot);
    expect(Object.keys(sdk)).toEqual([
      "list",
      "status",
      "analytics",
      "refreshConfig",
    ]);
    expect(typeof sdk.list).toBe("function");
    expect(typeof sdk.status).toBe("function");
    expect(typeof sdk.analytics).toBe("function");
    expect(typeof sdk.refreshConfig).toBe("function");
  });

  it("rejects malformed command inputs before loading configuration", async () => {
    const status = cradlewiseToolcraftRoot.children.find(
      (child) => child.name === "status",
    );
    const analytics = cradlewiseToolcraftRoot.children.find(
      (child) => child.name === "analytics",
    );
    expect(status && "handler" in status).toBe(true);
    expect(analytics && "handler" in analytics).toBe(true);
    if (
      !status ||
      !("handler" in status) ||
      !analytics ||
      !("handler" in analytics)
    ) {
      return;
    }

    await expect(
      status.handler({
        params: { cradleId: " " },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      status.handler({
        params: { cradleId: 1 },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      status.handler({
        params: { cradleId: "crib/other" },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      status.handler({
        params: { cradleId: ".." },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      status.handler({
        params: { cradleId: "crib?other" },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      status.handler({
        params: { cradleId: "a".repeat(257) },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("cradleId");
    await expect(
      analytics.handler({
        params: {
          cradleId: "crib",
          startDate: "2026-02-29 00:00:00",
        },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startDate");
    await expect(
      analytics.handler({
        params: { cradleId: "crib", startDate: 1 },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startDate");
    await expect(
      analytics.handler({
        params: { cradleId: "crib", startDate: "01/02/2026" },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startDate");
    await expect(
      analytics.handler({
        params: { cradleId: "crib", startDate: "2".repeat(65) },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startDate");
    await expect(
      analytics.handler({
        params: {
          cradleId: "crib",
          startDate: "2026-01-02 00:00:00",
          endDate: "2026-01-01 00:00:00",
        },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startDate must not be after endDate");
    await expect(
      analytics.handler({
        params: { cradleId: "crib", startHour: 1.5 },
        secrets: { email: "marker", password: "marker" },
      } as never),
    ).rejects.toThrow("startHour");
    await expect(
      status.handler({
        params: {},
        secrets: { email: " ", password: "marker" },
      } as never),
    ).rejects.toThrow("CRADLEWISE_LOGIN");
    await expect(
      status.handler({
        params: {},
        secrets: { email: "parent@example.com\nignored", password: "marker" },
      } as never),
    ).rejects.toThrow("without controls");
    await expect(
      status.handler({
        params: {},
        secrets: {
          email: `${"a".repeat(309)}@example.com`,
          password: "marker",
        },
      } as never),
    ).rejects.toThrow("320 bytes");
    await expect(
      status.handler({
        params: {},
        secrets: {
          email: "parent@example.com\u0085ignored",
          password: "marker",
        },
      } as never),
    ).rejects.toThrow("without controls");
    await expect(
      status.handler({
        params: {},
        secrets: {
          email: "parent@example.com",
          password: "x".repeat(4097),
        },
      } as never),
    ).rejects.toThrow("4096 bytes");
    expect(mocks.getAppConfig).not.toHaveBeenCalled();
  });

  it("does not expose embedded authentication configuration on refresh", async () => {
    mocks.refreshAppConfig.mockResolvedValue(
      new AppConfig({
        cognitoUserPoolId: "pool-sensitive",
        cognitoAppClientId: "client-sensitive",
        cognitoAppClientSecret: "secret-sensitive",
        cognitoIdentityPoolId: "identity-sensitive",
        cognitoRegion: "us-east-1",
        apiBaseUrl: "https://backend.cradlewise.com",
        iotEndpoint: "iot-ats.iot.us-east-1.amazonaws.com",
      }),
    );
    const command = cradlewiseToolcraftRoot.children.find(
      (child) => child.name === "refresh-config",
    );
    expect(command && "handler" in command).toBe(true);
    if (!command || !("handler" in command)) return;

    const result = await command.handler({ params: {} } as never);
    expect(result).toEqual({
      config: {
        cognitoRegion: "us-east-1",
        apiBaseUrl: "https://backend.cradlewise.com",
        realtimeConfigured: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("rejects aggregate CLI and MCP results above the safe budget", async () => {
    mocks.getAppConfig.mockResolvedValue(
      new AppConfig({
        cognitoUserPoolId: "pool",
        cognitoAppClientId: "client",
        cognitoAppClientSecret: "secret",
        cognitoIdentityPoolId: "identity",
        cognitoRegion: "us-east-1",
        apiBaseUrl: "https://backend.cradlewise.com",
      }),
    );
    const largeState = "x".repeat(9 * 1024 * 1024);
    const cradles = new Map([
      ["crib-1", new Cradle({ cradleId: "crib-1", state: { largeState } })],
      ["crib-2", new Cradle({ cradleId: "crib-2", state: { largeState } })],
    ]);
    const discover = vi
      .spyOn(CradlewiseClient.prototype, "discoverCradles")
      .mockResolvedValue(cradles);
    const update = vi
      .spyOn(CradlewiseClient.prototype, "updateCradle")
      .mockImplementation((cradle) => Promise.resolve(cradle));
    const status = cradlewiseToolcraftRoot.children.find(
      (child) => child.name === "status",
    );
    expect(status && "handler" in status).toBe(true);
    if (!status || !("handler" in status)) return;

    try {
      await expect(
        status.handler({
          params: {},
          secrets: { email: "parent@example.com", password: "password" },
        } as never),
      ).rejects.toThrow("safe size limit");
    } finally {
      discover.mockRestore();
      update.mockRestore();
    }
  });

  it("rejects command results containing undefined values", async () => {
    mocks.getAppConfig.mockResolvedValue(
      new AppConfig({
        cognitoUserPoolId: "pool",
        cognitoAppClientId: "client",
        cognitoAppClientSecret: "secret",
        cognitoIdentityPoolId: "identity",
        cognitoRegion: "us-east-1",
        apiBaseUrl: "https://backend.cradlewise.com",
      }),
    );
    const cradle = new Cradle({ cradleId: "crib" });
    const discover = vi
      .spyOn(CradlewiseClient.prototype, "discoverCradles")
      .mockResolvedValue(new Map([[cradle.cradleId, cradle]]));
    const fetchAnalytics = vi
      .spyOn(CradlewiseClient.prototype, "fetchSleepAnalytics")
      .mockResolvedValue({
        toJSON: () => ({ totalSleepMinutes: undefined }),
      } as never);
    const analytics = cradlewiseToolcraftRoot.children.find(
      (child) => child.name === "analytics",
    );
    expect(analytics && "handler" in analytics).toBe(true);
    if (!analytics || !("handler" in analytics)) return;

    try {
      await expect(
        analytics.handler({
          params: { cradleId: "crib" },
          secrets: { email: "parent@example.com", password: "password" },
        } as never),
      ).rejects.toThrow("not JSON-safe");
    } finally {
      discover.mockRestore();
      fetchAnalytics.mockRestore();
    }
  });
});
