import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp as makeTemporaryDirectory,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  AppConfig,
  getAppConfig,
  isApiBaseUrlForRegion,
  isAwsIotEndpointForRegion,
  isTrustedDiscoveredAppConfig,
  refreshAppConfig,
  rethrowWithConfigCleanups,
  withConfigCleanup,
} from "../src/config.js";
import { CradlewiseConfigError } from "../src/errors.js";
import {
  isTrustedDiscoveredConfig,
  isTrustedDiscoveredIotEndpoint,
} from "../src/discovery-trust.js";

vi.mock("../src/discovery-trust.js", () => ({
  isTrustedDiscoveredConfig: vi.fn(() => true),
  isTrustedDiscoveredIotEndpoint: vi.fn(() => true),
}));

const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function mkdtemp(prefix: string): Promise<string> {
  const directory = await makeTemporaryDirectory(prefix);
  fixtureDirectories.push(directory);
  return directory;
}

function rejectArbitrary(value: unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    Reflect.apply(reject, undefined, [value]);
  });
}

const data = {
  cognitoUserPoolId: "us-east-1_pool",
  cognitoAppClientId: "client",
  cognitoAppClientSecret: "secret",
  cognitoIdentityPoolId: "us-east-1:identity",
  cognitoRegion: "us-east-1",
  apiBaseUrl: "https://backend.cradlewise.com/",
  iotEndpoint: "endpoint-ats.iot.us-east-1.amazonaws.com",
};
const downloadUrl = "https://download.pureapk.com/b/XAPK/token?x=1";
const amplify = {
  auth: {
    plugins: {
      awsCognitoAuthPlugin: {
        CognitoUserPool: {
          Default: {
            PoolId: "pool",
            AppClientId: "client",
            AppClientSecret: "secret",
            Region: "us-east-1",
          },
        },
        CredentialsProvider: {
          CognitoIdentity: { Default: { PoolId: "identity" } },
        },
      },
    },
  },
  api: {
    plugins: {
      awsAPIPlugin: {
        yourApiName: { endpoint: "https://backend.cradlewise.com/api" },
      },
    },
  },
};

function validXapk(): Uint8Array {
  return zipSync({
    "base.apk": zipSync({
      "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
      "classes.dex": strToU8(
        "prefix abc123-ats.iot.us-east-1.amazonaws.com suffix",
      ),
    }),
  });
}

function validDownloadFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(strToU8(`binary${downloadUrl}binary`)))
    .mockResolvedValueOnce(new Response(Buffer.from(validXapk())));
}

describe("AppConfig", () => {
  it("preserves falsy configuration operation failures during cleanup", async () => {
    const cleanupError = new Error("cleanup failed");
    await expect(
      withConfigCleanup(
        () => rejectArbitrary(undefined),
        () => Promise.reject(cleanupError),
      ),
    ).rejects.toMatchObject({
      errors: [undefined, cleanupError],
      cause: cleanupError,
    });

    let rejected = false;
    try {
      await withConfigCleanup(
        () => rejectArbitrary(null),
        () => Promise.resolve(),
      );
    } catch (error) {
      rejected = true;
      expect(error).toBeNull();
    }
    expect(rejected).toBe(true);
  });

  it("retains download failures and every cleanup failure", async () => {
    const cleanupError = new Error("cleanup failed");
    await expect(
      rethrowWithConfigCleanups(
        undefined,
        [() => rejectArbitrary(null), () => Promise.reject(cleanupError)],
        "download cleanup failed",
      ),
    ).rejects.toMatchObject({
      message: "download cleanup failed",
      errors: [undefined, null, cleanupError],
      cause: undefined,
    });

    let rejected = false;
    try {
      await rethrowWithConfigCleanups(
        null,
        [() => Promise.resolve()],
        "unused",
      );
    } catch (error) {
      rejected = true;
      expect(error).toBeNull();
    }
    expect(rejected).toBe(true);
  });

  it("validates AWS IoT endpoint helpers safely", () => {
    expect(
      isAwsIotEndpointForRegion(
        "endpoint-ats.iot.us-east-1.amazonaws.com",
        "us-east-1",
      ),
    ).toBe(true);
    expect(isAwsIotEndpointForRegion("attacker.example", "us-east-1")).toBe(
      false,
    );
    expect(isAwsIotEndpointForRegion(1, "us-east-1")).toBe(false);
    expect(isAwsIotEndpointForRegion("endpoint", null)).toBe(false);
    expect(
      isAwsIotEndpointForRegion(
        "--ats.iot.us-east-1.amazonaws.com",
        "us-east-1",
      ),
    ).toBe(false);
    expect(
      isAwsIotEndpointForRegion(
        "-endpoint-ats.iot.us-east-1.amazonaws.com",
        "us-east-1",
      ),
    ).toBe(false);
    expect(
      isAwsIotEndpointForRegion(
        `${"a".repeat(60)}-ats.iot.us-east-1.amazonaws.com`,
        "us-east-1",
      ),
    ).toBe(false);
    expect(
      isAwsIotEndpointForRegion("endpoint-ats.iot.fake.amazonaws.com", "fake"),
    ).toBe(false);
    expect(
      isAwsIotEndpointForRegion(
        " endpoint-ats.iot.us-east-1.amazonaws.com ",
        "us-east-1",
      ),
    ).toBe(false);
    expect(isAwsIotEndpointForRegion("x".repeat(8193), "us-east-1")).toBe(
      false,
    );
    expect(
      isApiBaseUrlForRegion("https://backend.cradlewise.com/api", "us-east-1"),
    ).toBe(true);
    expect(isApiBaseUrlForRegion("https://example.com", "us-east-1")).toBe(
      false,
    );
    expect(isApiBaseUrlForRegion("x".repeat(8193), "us-east-1")).toBe(false);
    expect(
      isApiBaseUrlForRegion("https://backend.cradlewise.com", "x".repeat(256)),
    ).toBe(false);
    for (const value of [
      "https://backend.cradlewise.com@attacker.example/api",
      "https://backend.cradlewise.com\\@attacker.example/api",
      "https://backend.cradlewise.com:443@attacker.example/api",
      "https://attacker.example/backend.cradlewise.com",
    ]) {
      expect(isApiBaseUrlForRegion(value, "us-east-1")).toBe(false);
    }
    expect(
      isApiBaseUrlForRegion(
        " https://backend.cradlewise.com/api ",
        "us-east-1",
      ),
    ).toBe(false);
  });

  it("normalizes and serializes explicit configuration", () => {
    const config = new AppConfig({
      ...data,
      cognitoRegion: " us-east-1 ",
      apiBaseUrl: " https://backend.cradlewise.com/ ",
    });
    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com");
    expect(config.toJSON()).toEqual({
      ...data,
      cognitoRegion: "us-east-1",
      apiBaseUrl: "https://backend.cradlewise.com",
    });
    expect(Reflect.set(config, "apiBaseUrl", "https://attacker.example")).toBe(
      false,
    );
    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com");
  });

  it("recognizes only pinned auto-discovered configuration", () => {
    expect(isTrustedDiscoveredAppConfig(new AppConfig(data))).toBe(true);
    expect(isTrustedDiscoveredAppConfig({ ...data })).toBe(false);
    expect(
      isTrustedDiscoveredAppConfig(
        new AppConfig({
          cognitoUserPoolId: data.cognitoUserPoolId,
          cognitoAppClientId: data.cognitoAppClientId,
          cognitoAppClientSecret: data.cognitoAppClientSecret,
          cognitoIdentityPoolId: data.cognitoIdentityPoolId,
          cognitoRegion: "us-west-2",
          apiBaseUrl:
            "https://example.execute-api.us-west-2.amazonaws.com/production",
        }),
      ),
    ).toBe(false);
  });

  it("does not trust an overridden AppConfig serializer", () => {
    vi.mocked(isTrustedDiscoveredConfig).mockImplementationOnce(
      (candidate) => candidate.cognitoAppClientId === data.cognitoAppClientId,
    );
    class SpoofedConfig extends AppConfig {
      override toJSON() {
        return { ...data };
      }
    }
    const spoofed = new SpoofedConfig({
      ...data,
      cognitoAppClientId: "attacker-client",
    });
    expect(isTrustedDiscoveredAppConfig(spoofed)).toBe(false);
  });

  it("snapshots explicit configuration fields once", () => {
    const reads = new Map<string, number>();
    const input = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const config = new AppConfig(input as never);

    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com");
    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(data).map((key) => [key, 1])),
    );
  });

  it("parses Amplify configuration", () => {
    const config = AppConfig.fromAmplifyConfiguration(
      {
        auth: {
          plugins: {
            awsCognitoAuthPlugin: {
              CognitoUserPool: {
                Default: {
                  PoolId: "pool",
                  AppClientId: "client",
                  AppClientSecret: "secret",
                  Region: "us-east-1",
                },
              },
              CredentialsProvider: {
                CognitoIdentity: { Default: { PoolId: "identity" } },
              },
            },
          },
        },
        api: {
          plugins: {
            awsAPIPlugin: {
              yourApiName: {
                endpoint: "https://backend.cradlewise.com/api",
              },
            },
          },
        },
      },
      "iot-ats.iot.us-east-1.amazonaws.com",
    );
    expect(config.toJSON()).toMatchObject({
      cognitoUserPoolId: "pool",
      iotEndpoint: "iot-ats.iot.us-east-1.amazonaws.com",
    });
  });

  it("retains every cleanup failure after successful or failed work", async () => {
    const firstCleanupError = new Error("first cleanup failed");
    const secondCleanupError = new Error("second cleanup failed");
    const { withCleanupOperations } = await import("../src/config.js");

    await expect(
      withCleanupOperations(
        () => Promise.resolve("result"),
        [
          () => Promise.reject(firstCleanupError),
          () => Promise.reject(secondCleanupError),
        ],
        "cleanup failed",
      ),
    ).rejects.toMatchObject({
      errors: [firstCleanupError, secondCleanupError],
      cause: secondCleanupError,
    });
    await expect(
      withCleanupOperations(
        () => rejectArbitrary(undefined),
        [
          () => Promise.reject(firstCleanupError),
          () => Promise.reject(secondCleanupError),
        ],
        "operation and cleanup failed",
      ),
    ).rejects.toMatchObject({
      errors: [undefined, firstCleanupError, secondCleanupError],
      cause: secondCleanupError,
    });
  });

  it("rejects incomplete configuration", () => {
    expect(() => new AppConfig(null as never)).toThrow(
      "AppConfig data must be an object",
    );
    expect(() => new AppConfig({ ...data, apiBaseUrl: "" })).toThrow(
      CradlewiseConfigError,
    );
    expect(() => AppConfig.fromAmplifyConfiguration({})).toThrow(
      CradlewiseConfigError,
    );
    expect(() => new AppConfig({ ...data, cognitoRegion: "   " })).toThrow(
      CradlewiseConfigError,
    );
    expect(
      () => new AppConfig({ ...data, cognitoAppClientId: "client\ninjected" }),
    ).toThrow(CradlewiseConfigError);
    expect(
      () =>
        new AppConfig({
          ...data,
          cognitoAppClientSecret: "x".repeat(8193),
        }),
    ).toThrow(CradlewiseConfigError);
    expect(
      () => new AppConfig({ ...data, cognitoRegion: "not.a-region" }),
    ).toThrow("AWS region");
    expect(() => new AppConfig({ ...data, iotEndpoint: 123 as never })).toThrow(
      CradlewiseConfigError,
    );
    for (const iotEndpoint of [
      "iot.example.com",
      "https://abc-ats.iot.us-east-1.amazonaws.com",
      "abc-ats.iot.us-west-2.amazonaws.com",
      "abc.iot.us-east-1.amazonaws.com",
    ]) {
      expect(() => new AppConfig({ ...data, iotEndpoint })).toThrow(
        CradlewiseConfigError,
      );
    }
    for (const apiBaseUrl of [
      "not-a-url",
      "http://example.com",
      "https://user:password@example.com",
      "https://example.com?redirect=other",
      "https://example.com#fragment",
      "https://example.com?",
      "https://example.com#",
      "https://backend.cradlewise.com:8443",
      "https://api.execute-api.us-west-2.amazonaws.com/stage",
    ]) {
      expect(() => new AppConfig({ ...data, apiBaseUrl })).toThrow(
        CradlewiseConfigError,
      );
    }
  });

  it("canonicalizes API URL paths", () => {
    const config = new AppConfig({
      ...data,
      apiBaseUrl: "https://backend.cradlewise.com/api/../v1///",
    });
    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com/v1");
  });
});

describe("getAppConfig", () => {
  it("rejects malformed cache paths before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(getAppConfig(null as never)).rejects.toThrow(
      "options must be an object",
    );
    await expect(refreshAppConfig(null as never)).rejects.toThrow(
      "options must be an object",
    );
    await expect(getAppConfig({ fetch: 1 as never })).rejects.toThrow(
      "fetch must be a function",
    );
    await expect(
      getAppConfig({ forceRefresh: "yes" as never }),
    ).rejects.toThrow("forceRefresh must be a boolean");
    await expect(
      getAppConfig({ cachePath: "", fetch: fetchMock }),
    ).rejects.toThrow("cachePath");
    await expect(
      getAppConfig({ cachePath: "cache\nname", fetch: fetchMock }),
    ).rejects.toThrow("cachePath");
    await expect(
      getAppConfig({ cachePath: "x".repeat(4097), fetch: fetchMock }),
    ).rejects.toThrow("4096 bytes");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots configuration option getters once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const fetchMock = validDownloadFetch();
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      cachePath: join(directory, "config.json"),
      fetch: fetchMock,
      forceRefresh: true,
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    await expect(getAppConfig(options)).resolves.toMatchObject({
      cognitoRegion: "us-east-1",
    });
    expect(Object.fromEntries(reads)).toEqual({
      fetch: 1,
      forceRefresh: 1,
      cachePath: 1,
    });
  });

  it("snapshots refresh option getters without spreading extras", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const fetchMock = validDownloadFetch();
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      cachePath: join(directory, "config.json"),
      fetch: fetchMock,
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }
    Object.defineProperty(options, "ignored", {
      enumerable: true,
      get: () => {
        throw new Error("unexpected spread");
      },
    });

    await expect(refreshAppConfig(options)).resolves.toMatchObject({
      cognitoRegion: "us-east-1",
    });
    expect(Object.fromEntries(reads)).toEqual({ fetch: 1, cachePath: 1 });
  });

  it("snapshots custom discovery response properties once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const reads = new Map<string, number>();
    const count = (key: string): number => {
      const value = (reads.get(key) ?? 0) + 1;
      reads.set(key, value);
      return value;
    };
    const headers = {};
    Object.defineProperty(headers, "get", {
      enumerable: true,
      get: () => {
        count("headerMethod");
        return () => {
          count("headerCall");
          return null;
        };
      },
    });
    const body = new TextEncoder().encode(`binary${downloadUrl}binary`);
    const metadataResponse = {
      get status() {
        return count("status") === 1 ? 200 : 500;
      },
      get ok() {
        count("ok");
        return true;
      },
      get headers() {
        count("headers");
        return headers;
      },
      get body() {
        count("body");
        return null;
      },
      get arrayBuffer() {
        count("arrayBuffer");
        return () => Promise.resolve(body.buffer);
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataResponse as never)
      .mockResolvedValueOnce(new Response(Buffer.from(validXapk())));

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: fetchMock,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ cognitoRegion: "us-east-1" });
    expect(Object.fromEntries(reads)).toEqual({
      status: 1,
      ok: 1,
      headers: 1,
      body: 1,
      arrayBuffer: 1,
      headerMethod: 1,
      headerCall: 1,
    });
  });

  it("rejects invalid custom discovery body buffers before allocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const response = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: null,
      arrayBuffer: () => Promise.resolve(2_147_483_647),
    };

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response as never),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      cause: expect.objectContaining({
        message: "APKPure metadata returned an invalid body buffer",
      }),
    });

    const oversized = new ArrayBuffer(5 * 1024 * 1024 + 1);
    Object.defineProperty(oversized, "byteLength", { value: 0 });
    await expect(
      getAppConfig({
        cachePath: join(directory, "shadowed-buffer.json"),
        fetch: vi.fn<typeof fetch>().mockResolvedValue({
          ...response,
          arrayBuffer: () => Promise.resolve(oversized),
        } as never),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      cause: expect.objectContaining({
        message: "APKPure metadata exceeds the size limit",
      }),
    });
  });

  it("uses a valid cache without fetching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(cachePath, "{}", { mode: 0o644 });
    await chmod(cachePath, 0o644);
    await writeFile(cachePath, JSON.stringify({ cacheVersion: 1, ...data }));
    const fetchMock = vi.fn<typeof fetch>();
    const config = await getAppConfig({ cachePath, fetch: fetchMock });
    expect(config.cognitoAppClientId).toBe("client");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      cacheVersion: 1,
    });
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    await expect(readdir(directory)).resolves.toEqual(["config.json"]);
  });

  it("extracts config from a downloaded XAPK and writes the cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    const fetchMock = validDownloadFetch();

    const config = await getAppConfig({
      cachePath,
      fetch: fetchMock,
      forceRefresh: true,
    });
    expect(config.iotEndpoint).toBe("abc123-ats.iot.us-east-1.amazonaws.com");
    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com/api");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      cacheVersion: 1,
      cognitoUserPoolId: "pool",
    });
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    await expect(readdir(directory)).resolves.toEqual(["config.json"]);
  });

  it("coalesces concurrent configuration extraction by cache path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await mkdir(join(directory, "alias"));
    const fetchMock = validDownloadFetch();

    const [first, second] = await Promise.all([
      getAppConfig({ cachePath, fetch: fetchMock, forceRefresh: true }),
      getAppConfig({
        cachePath: join(directory, "alias", "..", "config.json"),
        fetch: fetchMock,
        forceRefresh: true,
      }),
    ]);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows configuration extraction to retry after a shared failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      Promise.all([
        getAppConfig({ cachePath, fetch: failedFetch, forceRefresh: true }),
        getAppConfig({ cachePath, fetch: failedFetch, forceRefresh: true }),
      ]),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
    expect(failedFetch).toHaveBeenCalledOnce();

    await expect(
      getAppConfig({
        cachePath,
        fetch: validDownloadFetch(),
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ cognitoUserPoolId: "pool" });
  });

  it("recovers from a corrupt cache by replacing it atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(cachePath, "{not-json", { mode: 0o644 });

    const config = await getAppConfig({
      cachePath,
      fetch: validDownloadFetch(),
    });
    expect(config.cognitoUserPoolId).toBe("pool");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      cacheVersion: 1,
      cognitoUserPoolId: "pool",
    });
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("recovers from malformed UTF-8 in the cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    const malformed = Buffer.from(
      JSON.stringify({ cacheVersion: 1, ...data }),
      "utf8",
    );
    malformed[malformed.indexOf("secret")] = 0xff;
    await writeFile(cachePath, malformed, { mode: 0o600 });
    const fetchMock = validDownloadFetch();

    await expect(
      getAppConfig({ cachePath, fetch: fetchMock }),
    ).resolves.toMatchObject({ cognitoUserPoolId: "pool" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a non-object JSON cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(cachePath, "null", { mode: 0o600 });
    const fetchMock = validDownloadFetch();

    await expect(
      getAppConfig({ cachePath, fetch: fetchMock }),
    ).resolves.toMatchObject({ cognitoUserPoolId: "pool" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      cacheVersion: 1,
    });
  });

  it("recovers from an owner-unreadable cache", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(cachePath, JSON.stringify({ cacheVersion: 1, ...data }), {
      mode: 0o000,
    });
    const fetchMock = validDownloadFetch();

    const config = await getAppConfig({ cachePath, fetch: fetchMock });

    expect(config.toJSON()).toMatchObject({
      cognitoUserPoolId: "pool",
      apiBaseUrl: "https://backend.cradlewise.com/api",
      iotEndpoint: "abc123-ats.iot.us-east-1.amazonaws.com",
    });
    expect(fetchMock).toHaveBeenCalled();
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("creates cache directories with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cacheDirectory = join(directory, "nested", "cache");
    const cachePath = join(cacheDirectory, "config.json");

    await getAppConfig({ cachePath, fetch: validDownloadFetch() });

    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("does not change permissions on unsafe custom cache directories", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cacheDirectory = join(directory, "shared");
    await mkdir(cacheDirectory, { mode: 0o755 });
    await chmod(cacheDirectory, 0o755);

    await expect(
      getAppConfig({
        cachePath: join(cacheDirectory, "config.json"),
        fetch: validDownloadFetch(),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o755);
    await expect(readdir(cacheDirectory)).resolves.toEqual([]);
  });

  it("refreshes cached configuration outside the pinned service boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        cacheVersion: 1,
        ...data,
        apiBaseUrl:
          "https://abc.execute-api.us-east-1.amazonaws.com/production",
      }),
    );
    const fetchMock = validDownloadFetch();

    const config = await getAppConfig({ cachePath, fetch: fetchMock });

    expect(config.apiBaseUrl).toBe("https://backend.cradlewise.com/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes cached configuration with an untrusted IoT endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    await writeFile(cachePath, JSON.stringify({ cacheVersion: 1, ...data }), {
      mode: 0o600,
    });
    vi.mocked(isTrustedDiscoveredIotEndpoint)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const fetchMock = validDownloadFetch();

    await expect(
      getAppConfig({ cachePath, fetch: fetchMock }),
    ).resolves.toMatchObject({
      iotEndpoint: "abc123-ats.iot.us-east-1.amazonaws.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces cache symlinks without touching their targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    const targetPath = join(directory, "target.json");
    const targetContents = `${JSON.stringify({ cacheVersion: 1, ...data })}\n`;
    await writeFile(targetPath, targetContents, { mode: 0o644 });
    await symlink(targetPath, cachePath);

    await getAppConfig({ cachePath, fetch: validDownloadFetch() });

    expect((await lstat(cachePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(targetPath, "utf8")).toBe(targetContents);
    expect((await stat(targetPath)).mode & 0o777).toBe(0o644);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to write through a symlinked cache directory", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const targetDirectory = join(directory, "target");
    const linkedDirectory = join(directory, "linked");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, linkedDirectory);

    await expect(
      getAppConfig({
        cachePath: join(linkedDirectory, "config.json"),
        fetch: validDownloadFetch(),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      message: expect.stringContaining("Unable to write app config cache"),
    });
    await expect(readdir(targetDirectory)).resolves.toEqual([]);
  });

  it("replaces hard-linked and oversized caches without altering targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const targetPath = join(directory, "target.json");
    const hardLinkPath = join(directory, "hardlink.json");
    const targetContents = `${JSON.stringify({ cacheVersion: 1, ...data })}\n`;
    await writeFile(targetPath, targetContents, { mode: 0o644 });
    await link(targetPath, hardLinkPath);

    await getAppConfig({
      cachePath: hardLinkPath,
      fetch: validDownloadFetch(),
    });
    expect(await readFile(targetPath, "utf8")).toBe(targetContents);
    expect((await stat(targetPath)).mode & 0o777).toBe(0o644);
    expect((await stat(hardLinkPath)).nlink).toBe(1);

    const oversizedPath = join(directory, "oversized.json");
    await writeFile(oversizedPath, " ".repeat(1024 * 1024 + 1));
    await getAppConfig({
      cachePath: oversizedPath,
      fetch: validDownloadFetch(),
    });
    expect(JSON.parse(await readFile(oversizedPath, "utf8"))).toMatchObject({
      cacheVersion: 1,
    });
  });

  it("selects only the IoT endpoint matching the Cognito region", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const xapk = zipSync({
      "base.apk": zipSync({
        "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
        "classes.dex": strToU8(
          "wrong-ats.iot.us-west-2.amazonaws.com right-ats.iot.us-east-1.amazonaws.com",
        ),
      }),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(downloadUrl))
      .mockResolvedValueOnce(new Response(Buffer.from(xapk)));

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({
      iotEndpoint: "right-ats.iot.us-east-1.amazonaws.com",
    });
  });

  it("rejects malformed UTF-8 in the embedded Amplify configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const amplifyBytes = strToU8(JSON.stringify(amplify));
    const secretOffset = Buffer.from(amplifyBytes).indexOf("secret");
    expect(secretOffset).toBeGreaterThanOrEqual(0);
    amplifyBytes[secretOffset] = 0xff;
    const xapk = zipSync({
      "base.apk": zipSync({
        "res/raw/amplifyconfiguration.json": amplifyBytes,
      }),
    });

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(xapk)),
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      cause: expect.objectContaining({ name: "TypeError" }),
    });
  });

  it("finds an IoT endpoint spanning a bounded DEX scan chunk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const prefix = new Uint8Array(1024 * 1024 - 12);
    const endpoint = strToU8("crossing-ats.iot.us-east-1.amazonaws.com");
    const dex = new Uint8Array(prefix.byteLength + endpoint.byteLength);
    dex.set(prefix);
    dex.set(endpoint, prefix.byteLength);
    const xapk = zipSync({
      "base.apk": zipSync({
        "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
        "classes.dex": [dex, { level: 0 }],
      }),
    });

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(xapk)),
      }),
    ).resolves.toMatchObject({
      iotEndpoint: "crossing-ats.iot.us-east-1.amazonaws.com",
    });
  });

  it("does not manufacture endpoints from long DEX identifier runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const dex = strToU8(
      `${"x".repeat(1024 * 1024)}-ats.iot.us-east-1.amazonaws.com`,
    );
    const xapk = zipSync({
      "base.apk": zipSync({
        "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
        "classes.dex": dex,
      }),
    });

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(xapk)),
      }),
    ).resolves.toMatchObject({ iotEndpoint: undefined });
  });

  it("drops an untrusted discovered IoT endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    vi.mocked(isTrustedDiscoveredIotEndpoint).mockReturnValueOnce(false);

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: validDownloadFetch(),
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ iotEndpoint: undefined });
  });

  it("prefers base.apk over earlier non-config split APKs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const xapk = zipSync({
      "asset-pack.apk": zipSync({ "assets/data": strToU8("not config") }),
      "base.apk": zipSync({
        "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
        "classes.dex": strToU8("right-ats.iot.us-east-1.amazonaws.com"),
      }),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(downloadUrl))
      .mockResolvedValueOnce(new Response(Buffer.from(xapk)));

    await expect(
      getAppConfig({
        cachePath: join(directory, "config.json"),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ cognitoUserPoolId: "pool" });
  });

  it("wraps metadata and bundle discovery failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cases: Array<[string, typeof fetch]> = [
      [
        "metadata-status",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 503 })),
      ],
      [
        "missing-download-url",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("no download")),
      ],
      [
        "oversized-metadata",
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            headers: { "content-length": String(6 * 1024 * 1024) },
          }),
        ),
      ],
      [
        "invalid-content-length",
        vi.fn<typeof fetch>().mockResolvedValue({
          status: 200,
          ok: true,
          headers: { get: () => "0x10" },
          body: null,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        } as never),
      ],
      [
        "oversized-xapk",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(null, {
              headers: { "content-length": String(513 * 1024 * 1024) },
            }),
          ),
      ],
      [
        "unsafe-xapk-redirect",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(`prefix ${downloadUrl} suffix`, { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(null, {
              status: 302,
              headers: { location: "http://127.0.0.1/internal" },
            }),
          ),
      ],
      [
        "missing-base-apk",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(zipSync({ "config.en.apk": new Uint8Array() })),
            ),
          ),
      ],
      [
        "ambiguous-named-base-apk",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(
                zipSync({
                  "first/base.apk": new Uint8Array(),
                  "second/base.apk": new Uint8Array(),
                }),
              ),
            ),
          ),
      ],
      [
        "ambiguous-fallback-base-apk",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(
                zipSync({
                  "app-one.apk": new Uint8Array(),
                  "app-two.apk": new Uint8Array(),
                }),
              ),
            ),
          ),
      ],
      [
        "missing-amplify-config",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(
                zipSync({
                  "base.apk": zipSync({ "classes.dex": strToU8("none") }),
                }),
              ),
            ),
          ),
      ],
      [
        "untrusted-discovered-service",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(
                zipSync({
                  "base.apk": zipSync({
                    "res/raw/amplifyconfiguration.json": strToU8(
                      JSON.stringify({
                        ...amplify,
                        api: {
                          plugins: {
                            awsAPIPlugin: {
                              yourApiName: {
                                endpoint:
                                  "https://abc.execute-api.us-east-1.amazonaws.com/prod",
                              },
                            },
                          },
                        },
                      }),
                    ),
                  }),
                }),
              ),
            ),
          ),
      ],
      [
        "oversized-amplify-config",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(
            new Response(
              Buffer.from(
                zipSync({
                  "base.apk": zipSync({
                    "res/raw/amplifyconfiguration.json": strToU8(
                      " ".repeat(1024 * 1024 + 1),
                    ),
                  }),
                }),
              ),
            ),
          ),
      ],
    ];

    for (const [name, fetchMock] of cases) {
      await expect(
        getAppConfig({
          cachePath: join(directory, `${name}.json`),
          fetch: fetchMock,
          forceRefresh: true,
        }),
      ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
    }
  });

  it("cancels rejected metadata and bundle response bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const metadataCancel = vi.fn(() => new Promise<void>(() => undefined));
    const metadataBody = new ReadableStream({ cancel: metadataCancel });
    await expect(
      getAppConfig({
        cachePath: join(directory, "metadata.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(metadataBody, { status: 503 })),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
    expect(metadataCancel).toHaveBeenCalledOnce();

    const bundleCancel = vi.fn(() => new Promise<void>(() => undefined));
    const bundleBody = new ReadableStream({ cancel: bundleCancel });
    await expect(
      getAppConfig({
        cachePath: join(directory, "bundle.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(bundleBody, { status: 503 })),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
    expect(bundleCancel).toHaveBeenCalledOnce();
  });

  it("snapshots download stream methods and rejects malformed chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    let getReaderReads = 0;
    let readMethodReads = 0;
    const cancel = vi.fn(() => Promise.resolve());
    const releaseLock = vi.fn();
    const body = {
      get getReader() {
        getReaderReads += 1;
        if (getReaderReads > 1) throw new Error("getReader read twice");
        return () => ({
          get read() {
            readMethodReads += 1;
            if (readMethodReads > 1) throw new Error("read method read twice");
            return () => Promise.resolve({ done: false, value: "not-bytes" });
          },
          cancel,
          releaseLock,
        });
      },
      cancel: () => Promise.resolve(),
    };

    await expect(
      getAppConfig({
        cachePath: join(directory, "invalid-stream.json"),
        fetch: vi.fn<typeof fetch>().mockResolvedValue({
          status: 200,
          ok: true,
          headers: new Headers(),
          body,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        } as never),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      cause: expect.objectContaining({
        message: "Download response returned an invalid stream chunk",
      }),
    });
    expect(getReaderReads).toBe(1);
    expect(readMethodReads).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("uses arrayBuffer fallback for cancellable non-streaming bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cancel = vi.fn(() => Promise.resolve());
    const metadata = new TextEncoder().encode(`binary${downloadUrl}binary`);

    await expect(
      getAppConfig({
        cachePath: join(directory, "buffer-fallback.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: { cancel },
            arrayBuffer: () => Promise.resolve(metadata.buffer),
          } as never)
          .mockResolvedValueOnce(new Response(Buffer.from(validXapk()))),
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ cognitoRegion: "us-east-1" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("uses typed-array internal lengths for download limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    let reads = 0;
    const cancel = vi.fn(() => Promise.resolve());

    await expect(
      getAppConfig({
        cachePath: join(directory, "shadowed-length.json"),
        fetch: vi.fn<typeof fetch>().mockResolvedValue({
          status: 200,
          ok: true,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: () =>
                Promise.resolve(
                  reads++ === 0
                    ? { done: false, value: bytes }
                    : { done: true },
                ),
              cancel,
              releaseLock: () => undefined,
            }),
            cancel: () => Promise.resolve(),
          },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        } as never),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({
      name: "CradlewiseConfigError",
      cause: expect.objectContaining({
        message: "APKPure metadata exceeds the size limit",
      }),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("removes large-response spool files after stream failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("cradlewise-download-"))
      .sort();
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          return;
        }
        controller.error(new Error("injected stream failure"));
      },
    });

    await expect(
      getAppConfig({
        cachePath: join(directory, "stream-failure.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(body)),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });

    const after = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("cradlewise-download-"))
      .sort();
    expect(after).toEqual(before);
  });

  it("rejects excessive download chunk counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 8193) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(Uint8Array.of(120));
      },
    });

    await expect(
      getAppConfig({
        cachePath: join(directory, "chunks.json"),
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ name: "CradlewiseConfigError" });
  });

  it("enforces discovery timeouts when custom fetch ignores signals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    try {
      const discovery = getAppConfig({
        cachePath: join(directory, "timeout.json"),
        fetch: fetchMock,
        forceRefresh: true,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new DOMException("Timed out", "TimeoutError"));

      await expect(discovery).rejects.toMatchObject({
        name: "CradlewiseConfigError",
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("parses and removes successfully spooled bundle responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("cradlewise-download-"))
      .sort();
    const padding = new Uint8Array(8 * 1024 * 1024 + 1);
    const xapk = zipSync(
      {
        "base.apk": zipSync({
          "res/raw/amplifyconfiguration.json": strToU8(JSON.stringify(amplify)),
        }),
        "ignored.bin": padding,
      },
      { level: 0 },
    );

    await expect(
      getAppConfig({
        cachePath: join(directory, "spooled.json"),
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(downloadUrl))
          .mockResolvedValueOnce(new Response(xapk)),
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ cognitoRegion: "us-east-1" });

    const after = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("cradlewise-download-"))
      .sort();
    expect(after).toEqual(before);
  });

  it("follows only the approved APKPure CDN redirect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cradlewise-test-"));
    const cachePath = join(directory, "config.json");
    const finalResponse = new Response(Buffer.from(validXapk()));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(`prefix ${downloadUrl} suffix`, { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://data.winudf.com/XAPK/file?token=verified",
          },
        }),
      )
      .mockResolvedValueOnce(finalResponse);

    await expect(
      getAppConfig({ cachePath, fetch: fetchMock, forceRefresh: true }),
    ).resolves.toMatchObject({ cognitoRegion: "us-east-1" });
    expect(fetchMock.mock.calls[2]?.[0]).toEqual(
      new URL("https://data.winudf.com/XAPK/file?token=verified"),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.redirect).toBe("error");
  });
});
