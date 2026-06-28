import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getArrayBufferByteLength, snapshotUint8Array } from "./byte-utils.js";
import { DEFAULT_REGION } from "./constants.js";
import {
  isTrustedDiscoveredConfig,
  isTrustedDiscoveredIotEndpoint,
} from "./discovery-trust.js";
import { CradlewiseConfigError } from "./errors.js";
import { utf8ByteLength } from "./text-utils.js";
import {
  readZipEntries,
  readZipEntryBytes,
  streamZipEntry,
  writeZipEntryToFile,
} from "./zip-utils.js";
import type { ZipEntry } from "./zip-utils.js";
import type { AppConfigData, JsonObject } from "./types.js";

const PACKAGE_NAME = "com.cradlewise.nini.app";
const APKPURE_API = "https://api.pureapk.com/m/v3/cms/app_version";
const CONFIG_PATH_IN_APK = "res/raw/amplifyconfiguration.json";
const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_XAPK_BYTES = 512 * 1024 * 1024;
const MAX_BASE_APK_BYTES = 512 * 1024 * 1024;
const MAX_SELECTED_APK_CONTENT_BYTES = 256 * 1024 * 1024;
const MAX_AMPLIFY_CONFIG_BYTES = 1024 * 1024;
const MAX_IN_MEMORY_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEX_SCAN_OVERLAP_BYTES = 256;
const MAX_IOT_ENDPOINT_CANDIDATES = 1024;
const MAX_RESPONSE_CHUNKS = 8192;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_CONFIG_STRING_BYTES = 8192;
const DEFAULT_CACHE_PATH = join(
  homedir(),
  ".cradlewise",
  "cradlewise_app_config.json",
);
const APKPURE_HEADERS = {
  "user-agent": "APKPure/3.19.85 (Dalvik/2.1.0)",
  "x-abis": "arm64-v8a",
  "x-cv": "3172501",
  "x-gp": "1",
  "x-sv": "29",
};
const configLoads = new Map<string, Promise<AppConfig>>();

interface CachedConfig extends AppConfigData {
  cacheVersion: number;
}

export interface GetAppConfigOptions {
  cachePath?: string;
  fetch?: typeof fetch;
  forceRefresh?: boolean;
}

export class AppConfig {
  readonly cognitoUserPoolId: string;
  readonly cognitoAppClientId: string;
  readonly cognitoAppClientSecret: string;
  readonly cognitoIdentityPoolId: string;
  readonly cognitoRegion: string;
  readonly apiBaseUrl: string;
  readonly iotEndpoint: string | undefined;

  constructor(data: AppConfigData) {
    if (!isRecord(data)) {
      throw new CradlewiseConfigError("AppConfig data must be an object");
    }
    const cognitoUserPoolId = data.cognitoUserPoolId;
    const cognitoAppClientId = data.cognitoAppClientId;
    const cognitoAppClientSecret = data.cognitoAppClientSecret;
    const cognitoIdentityPoolId = data.cognitoIdentityPoolId;
    const cognitoRegion = data.cognitoRegion;
    const apiBaseUrl = data.apiBaseUrl;
    const iotEndpoint = data.iotEndpoint;
    this.cognitoUserPoolId = requireString(
      cognitoUserPoolId,
      "cognitoUserPoolId",
    );
    this.cognitoAppClientId = requireString(
      cognitoAppClientId,
      "cognitoAppClientId",
    );
    this.cognitoAppClientSecret = requireString(
      cognitoAppClientSecret,
      "cognitoAppClientSecret",
    );
    this.cognitoIdentityPoolId = requireString(
      cognitoIdentityPoolId,
      "cognitoIdentityPoolId",
    );
    this.cognitoRegion = requireAwsRegion(cognitoRegion);
    this.apiBaseUrl = requireApiBaseUrl(apiBaseUrl, this.cognitoRegion);
    this.iotEndpoint = optionalIotEndpoint(iotEndpoint, this.cognitoRegion);
    Object.freeze(this);
  }

  static fromAmplifyConfiguration(
    raw: JsonObject,
    iotEndpoint?: string,
  ): AppConfig {
    try {
      const auth = raw.auth as JsonObject;
      const authPlugins = auth.plugins as JsonObject;
      const cognito = authPlugins.awsCognitoAuthPlugin as JsonObject;
      const userPoolContainer = cognito.CognitoUserPool as JsonObject;
      const userPool = userPoolContainer.Default as JsonObject;
      const credentialsProvider = cognito.CredentialsProvider as JsonObject;
      const cognitoIdentity = credentialsProvider.CognitoIdentity as JsonObject;
      const identityPool = cognitoIdentity.Default as JsonObject;
      const api = raw.api as JsonObject;
      const apiPlugins = api.plugins as JsonObject;
      const awsApiPlugin = apiPlugins.awsAPIPlugin as JsonObject;
      const apiConfig = awsApiPlugin.yourApiName as JsonObject;

      return new AppConfig({
        cognitoUserPoolId: readString(userPool.PoolId, "PoolId"),
        cognitoAppClientId: readString(userPool.AppClientId, "AppClientId"),
        cognitoAppClientSecret: readString(
          userPool.AppClientSecret,
          "AppClientSecret",
        ),
        cognitoIdentityPoolId: readString(
          identityPool.PoolId,
          "IdentityPoolId",
        ),
        cognitoRegion: readString(userPool.Region, "Region"),
        apiBaseUrl: readString(apiConfig.endpoint, "API endpoint"),
        ...(iotEndpoint ? { iotEndpoint } : {}),
      });
    } catch (error) {
      throw new CradlewiseConfigError(
        "Invalid Cradlewise Amplify configuration",
        {
          cause: error,
        },
      );
    }
  }

  toJSON(): AppConfigData {
    return {
      cognitoUserPoolId: this.cognitoUserPoolId,
      cognitoAppClientId: this.cognitoAppClientId,
      cognitoAppClientSecret: this.cognitoAppClientSecret,
      cognitoIdentityPoolId: this.cognitoIdentityPoolId,
      cognitoRegion: this.cognitoRegion,
      apiBaseUrl: this.apiBaseUrl,
      ...(this.iotEndpoint ? { iotEndpoint: this.iotEndpoint } : {}),
    };
  }
}

export async function getAppConfig(
  options: GetAppConfigOptions = {},
): Promise<AppConfig> {
  if (!isRecord(options)) {
    throw new CradlewiseConfigError("options must be an object");
  }
  const fetchImplementation = options.fetch;
  const forceRefresh = options.forceRefresh;
  const requestedCachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  if (
    fetchImplementation !== undefined &&
    typeof fetchImplementation !== "function"
  ) {
    throw new CradlewiseConfigError("fetch must be a function");
  }
  if (forceRefresh !== undefined && typeof forceRefresh !== "boolean") {
    throw new CradlewiseConfigError("forceRefresh must be a boolean");
  }
  if (
    typeof requestedCachePath !== "string" ||
    utf8ByteLength(requestedCachePath, 4096) > 4096 ||
    hasControlCharacter(requestedCachePath)
  ) {
    throw new CradlewiseConfigError(
      "cachePath must be a nonempty control-free path no longer than 4096 bytes",
    );
  }
  if (requestedCachePath.trim().length === 0) {
    throw new CradlewiseConfigError("cachePath must be a nonempty path");
  }
  const cachePath = resolve(requestedCachePath);
  if (utf8ByteLength(cachePath, 4096) > 4096) {
    throw new CradlewiseConfigError(
      "resolved cachePath must be no longer than 4096 bytes",
    );
  }
  if (!forceRefresh) {
    const cached = await readCachedConfig(cachePath);
    if (cached) return cached;
  }
  let load = configLoads.get(cachePath);
  if (!load) {
    const pending = extractAppConfig(
      fetchImplementation ?? globalThis.fetch,
    ).then(async (config) => {
      await writeCachedConfig(cachePath, config);
      return config;
    });
    const tracked = pending.finally(() => {
      if (configLoads.get(cachePath) === tracked) configLoads.delete(cachePath);
    });
    configLoads.set(cachePath, tracked);
    load = tracked;
  }
  return load;
}

export async function refreshAppConfig(
  options: Omit<GetAppConfigOptions, "forceRefresh"> = {},
): Promise<AppConfig> {
  if (!isRecord(options)) {
    throw new CradlewiseConfigError("options must be an object");
  }
  const fetchImplementation = options.fetch;
  const cachePath = options.cachePath;
  return getAppConfig({
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
    ...(cachePath === undefined ? {} : { cachePath }),
    forceRefresh: true,
  });
}

async function readCachedConfig(
  cachePath: string,
): Promise<AppConfig | undefined> {
  try {
    const expectedUserId = process.getuid?.();
    const pathMetadata = await lstat(cachePath);
    if (!isSafeCacheFile(pathMetadata, expectedUserId)) return undefined;
    const handle = await open(
      cachePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      let metadata = await handle.stat();
      if (
        !isSafeCacheFile(metadata, expectedUserId) ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino
      ) {
        return undefined;
      }
      await handle.chmod(0o600);
      metadata = await handle.stat();
      const contents = await readBoundedCacheFile(handle);
      if (contents === undefined) return undefined;
      const [after, pathAfter] = await Promise.all([
        handle.stat(),
        lstat(cachePath),
      ]);
      if (
        !sameCacheFile(metadata, after, expectedUserId) ||
        !sameCacheFile(metadata, pathAfter, expectedUserId)
      ) {
        return undefined;
      }
      const raw: unknown = JSON.parse(contents);
      if (!isRecord(raw) || raw.cacheVersion !== CACHE_VERSION) {
        return undefined;
      }
      const config = new AppConfig(raw as unknown as AppConfigData);
      return isTrustedDiscoveredAppConfig(config) ? config : undefined;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "ELOOP" ||
      code === "EACCES" ||
      code === "EPERM" ||
      error instanceof SyntaxError ||
      error instanceof CradlewiseConfigError
    ) {
      return undefined;
    }
    throw new CradlewiseConfigError(
      `Unable to read app config cache at ${cachePath}`,
      {
        cause: error,
      },
    );
  }
}

async function readBoundedCacheFile(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string | undefined> {
  const bytes = Buffer.allocUnsafe(MAX_CACHE_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_CACHE_BYTES) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } catch {
    return undefined;
  }
}

function sameCacheFile(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>>,
  expectedUserId: number | undefined,
): boolean {
  return (
    isSafeCacheFile(second, expectedUserId) &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.nlink === second.nlink &&
    first.size === second.size &&
    first.mode === second.mode &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

function isSafeCacheFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expectedUserId: number | undefined,
): boolean {
  return (
    metadata.isFile() &&
    metadata.size <= MAX_CACHE_BYTES &&
    metadata.nlink === 1 &&
    (expectedUserId === undefined || metadata.uid === expectedUserId)
  );
}

async function writeCachedConfig(
  cachePath: string,
  config: AppConfig,
): Promise<void> {
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await withConfigCleanup(
      async () => {
        const cacheDirectory = dirname(cachePath);
        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        await secureCacheDirectory(
          cacheDirectory,
          cachePath === resolve(DEFAULT_CACHE_PATH),
        );
        const data: CachedConfig = {
          cacheVersion: CACHE_VERSION,
          ...config.toJSON(),
        };
        await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryPath, cachePath);
      },
      () => rm(temporaryPath, { force: true }),
    );
  } catch (error) {
    throw new CradlewiseConfigError(
      `Unable to write app config cache at ${cachePath}`,
      {
        cause: error,
      },
    );
  }
}

async function secureCacheDirectory(
  directory: string,
  repairPermissions: boolean,
): Promise<void> {
  const expectedUserId = process.getuid?.();
  const pathMetadata = await lstat(directory);
  if (
    !pathMetadata.isDirectory() ||
    pathMetadata.isSymbolicLink() ||
    (expectedUserId !== undefined && pathMetadata.uid !== expectedUserId) ||
    (process.platform !== "win32" &&
      !repairPermissions &&
      (pathMetadata.mode & 0o077) !== 0)
  ) {
    throw new Error("Cache directory is not a safe owned directory");
  }
  const handle = await open(
    directory,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      (expectedUserId !== undefined && metadata.uid !== expectedUserId)
    ) {
      throw new Error("Cache directory changed during validation");
    }
    if (process.platform !== "win32" && repairPermissions) {
      await handle.chmod(0o700);
    }
  } finally {
    await handle.close();
  }
}

async function extractAppConfig(
  fetchImplementation: typeof fetch,
): Promise<AppConfig> {
  let temporaryDirectory: string | undefined;
  try {
    return await withConfigCleanup(
      async () => {
        const downloadUrl = await getApkDownloadUrl(fetchImplementation);
        const { response, signal } = await fetchXapk(
          fetchImplementation,
          downloadUrl,
        );
        if (!response.ok) {
          cancelResponseBody(response);
          throw new Error(`APK download failed with HTTP ${response.status}`);
        }

        const download = await downloadResponseToTemporaryFile(
          response,
          MAX_XAPK_BYTES,
          "XAPK download",
          signal,
        );
        temporaryDirectory = download.directory;
        const xapkEntries = await readZipEntries(
          download.path,
          MAX_XAPK_BYTES,
          MAX_ARCHIVE_ENTRIES,
        );
        const baseApkEntry = selectBaseApkEntry(xapkEntries);
        const baseApkPath = join(temporaryDirectory, "base.apk");
        await writeZipEntryToFile(
          download.path,
          baseApkEntry,
          baseApkPath,
          MAX_BASE_APK_BYTES,
        );

        const apkEntries = await readZipEntries(
          baseApkPath,
          MAX_BASE_APK_BYTES,
          MAX_ARCHIVE_ENTRIES,
        );
        const amplifyEntries = apkEntries.filter(
          (entry) => entry.name === CONFIG_PATH_IN_APK,
        );
        if (amplifyEntries.length !== 1) {
          throw new Error(
            amplifyEntries.length === 0
              ? `${CONFIG_PATH_IN_APK} not found in APK`
              : "APK contains multiple Amplify configurations",
          );
        }
        const amplifyEntry = amplifyEntries[0];
        if (!amplifyEntry)
          throw new Error(`${CONFIG_PATH_IN_APK} not found in APK`);
        const dexEntries = apkEntries.filter((entry) =>
          entry.name.endsWith(".dex"),
        );
        let selectedContentBytes = amplifyEntry.originalSize;
        for (const entry of dexEntries) {
          selectedContentBytes += entry.originalSize;
          if (selectedContentBytes > MAX_SELECTED_APK_CONTENT_BYTES) {
            throw new Error("Selected APK content exceeds the size limit");
          }
        }
        const amplifyBytes = await readZipEntryBytes(
          baseApkPath,
          amplifyEntry,
          MAX_AMPLIFY_CONFIG_BYTES,
        );
        const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(amplifyBytes),
        ) as JsonObject;
        const baseConfig = AppConfig.fromAmplifyConfiguration(raw);
        if (!isTrustedDiscoveredAppConfig(baseConfig)) {
          throw new Error(
            "Discovered app configuration does not match the pinned Cradlewise service boundary",
          );
        }
        const discoveredIotEndpoint = await extractIotEndpointFromEntries(
          baseApkPath,
          dexEntries,
          baseConfig.cognitoRegion,
        );
        const iotEndpoint =
          discoveredIotEndpoint &&
          isTrustedDiscoveredIotEndpoint(discoveredIotEndpoint)
            ? discoveredIotEndpoint
            : undefined;
        return iotEndpoint
          ? new AppConfig({ ...baseConfig.toJSON(), iotEndpoint })
          : baseConfig;
      },
      async () => {
        if (temporaryDirectory) {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
      },
    );
  } catch (error) {
    if (error instanceof CradlewiseConfigError) throw error;
    throw new CradlewiseConfigError(
      "Unable to discover Cradlewise app configuration. Pass an AppConfig explicitly or retry later.",
      { cause: error },
    );
  }
}

export async function withConfigCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  return withCleanupOperations(
    operation,
    [cleanup],
    "Cradlewise configuration operation and cleanup failed",
  );
}

export async function withCleanupOperations<T>(
  operation: () => Promise<T>,
  cleanups: ReadonlyArray<() => Promise<unknown>>,
  message: string,
): Promise<T> {
  let result: T | undefined;
  let operationFailed = false;
  let primaryError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      operationFailed ? [primaryError, ...cleanupErrors] : cleanupErrors,
      message,
      { cause: cleanupErrors.at(-1) },
    );
  }
  if (operationFailed) throw primaryError;
  return result as T;
}

function selectBaseApkEntry(entries: ZipEntry[]): ZipEntry {
  const exact = entries.filter(
    (entry) => entry.name === "base.apk" || entry.name.endsWith("/base.apk"),
  );
  if (exact.length > 1) {
    throw new Error("XAPK contains multiple base APK candidates");
  }
  if (exact[0]) return exact[0];
  const fallback = entries.filter(
    (entry) => entry.name.endsWith(".apk") && !entry.name.includes("config."),
  );
  if (fallback.length > 1) {
    throw new Error("XAPK contains multiple base APK candidates");
  }
  if (!fallback[0]) throw new Error("No base APK found in XAPK bundle");
  return fallback[0];
}

async function extractIotEndpointFromEntries(
  archivePath: string,
  entries: ZipEntry[],
  region: string,
): Promise<string | undefined> {
  let endpoint: string | undefined;
  const candidateBudget = { count: 0 };
  const suffix = new TextEncoder().encode(`-ats.iot.${region}.amazonaws.com`);
  for (const entry of entries) {
    let trailing: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for await (const chunk of streamZipEntry(archivePath, entry)) {
      endpoint = findIotEndpointInBytes(
        trailing,
        chunk,
        suffix,
        region,
        candidateBudget,
      );
      if (endpoint) return endpoint;
      trailing = copyVirtualTail(trailing, chunk, DEX_SCAN_OVERLAP_BYTES);
    }
  }
  return endpoint;
}
export function isTrustedDiscoveredAppConfig(
  value: unknown,
): value is AppConfig {
  if (!(value instanceof AppConfig)) return false;
  const fingerprintInput: AppConfigData = {
    cognitoUserPoolId: value.cognitoUserPoolId,
    cognitoAppClientId: value.cognitoAppClientId,
    cognitoAppClientSecret: value.cognitoAppClientSecret,
    cognitoIdentityPoolId: value.cognitoIdentityPoolId,
    cognitoRegion: value.cognitoRegion,
    apiBaseUrl: value.apiBaseUrl,
  };
  return (
    value.cognitoRegion === DEFAULT_REGION &&
    new URL(value.apiBaseUrl).hostname === "backend.cradlewise.com" &&
    isTrustedDiscoveredConfig(fingerprintInput) &&
    (value.iotEndpoint === undefined ||
      isTrustedDiscoveredIotEndpoint(value.iotEndpoint))
  );
}

async function getApkDownloadUrl(
  fetchImplementation: typeof fetch,
): Promise<string> {
  const url = new URL(APKPURE_API);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("package_name", PACKAGE_NAME);
  const signal = AbortSignal.timeout(30_000);
  const response = await raceWithAbort(
    fetchImplementation(url, {
      headers: APKPURE_HEADERS,
      redirect: "error",
      signal,
    }),
    signal,
    undefined,
    (lateResponse) => {
      cancelResponseBody(lateResponse);
    },
  );
  const snapshot = snapshotDownloadResponse(response);
  if (!snapshot) {
    cancelResponseBody(response);
    throw new Error("APKPure metadata returned an invalid fetch response");
  }
  if (!snapshot.ok) {
    cancelResponseBody(snapshot);
    throw new Error(`APKPure metadata failed with HTTP ${snapshot.status}`);
  }

  const body = new TextDecoder("latin1").decode(
    await readResponseBytes(
      snapshot,
      MAX_METADATA_BYTES,
      "APKPure metadata",
      signal,
    ),
  );
  const match = body.match(
    /https:\/\/download\.pureapk\.com\/b\/XAPK\/[A-Za-z0-9_=-]+\?[A-Za-z0-9_.&=%+-]+/,
  );
  if (!match)
    throw new Error("APKPure response did not contain an XAPK download URL");
  return match[0];
}

async function fetchXapk(
  fetchImplementation: typeof fetch,
  downloadUrl: string,
): Promise<{ response: DownloadResponseSnapshot; signal: AbortSignal }> {
  const signal = AbortSignal.timeout(300_000);
  const options: RequestInit = {
    headers: { "user-agent": APKPURE_HEADERS["user-agent"] },
    redirect: "manual",
    signal,
  };
  const rawResponse = await raceWithAbort(
    fetchImplementation(downloadUrl, options),
    signal,
    undefined,
    (lateResponse) => {
      cancelResponseBody(lateResponse);
    },
  );
  const response = snapshotDownloadResponse(rawResponse);
  if (!response) {
    cancelResponseBody(rawResponse);
    throw new Error("XAPK download returned an invalid fetch response");
  }
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return { response, signal };
  }

  const location = readDownloadHeader(response, "location");
  cancelResponseBody(response);
  if (!location) throw new Error("XAPK redirect did not include a location");
  const redirected = new URL(location, downloadUrl);
  if (
    redirected.protocol !== "https:" ||
    redirected.hostname !== "data.winudf.com" ||
    redirected.port ||
    redirected.username ||
    redirected.password
  ) {
    throw new Error("XAPK redirect target is not an approved APKPure CDN host");
  }
  const redirectedResponse = await raceWithAbort(
    fetchImplementation(redirected, {
      ...options,
      redirect: "error",
    }),
    signal,
    undefined,
    (lateResponse) => {
      cancelResponseBody(lateResponse);
    },
  );
  const redirectedSnapshot = snapshotDownloadResponse(redirectedResponse);
  if (!redirectedSnapshot) {
    cancelResponseBody(redirectedResponse);
    throw new Error("XAPK redirect returned an invalid fetch response");
  }
  return { response: redirectedSnapshot, signal };
}

function findIotEndpointInBytes(
  prefix: Uint8Array,
  chunk: Uint8Array,
  suffix: Uint8Array,
  region: string,
  candidateBudget: { count: number },
): string | undefined {
  const length = prefix.byteLength + chunk.byteLength;
  for (let marker = 0; marker + suffix.byteLength <= length; marker += 1) {
    if (marker + suffix.byteLength <= prefix.byteLength) continue;
    if (virtualByte(prefix, chunk, marker) !== suffix[0]) continue;
    let suffixMatches = true;
    for (let index = 1; index < suffix.byteLength; index += 1) {
      if (virtualByte(prefix, chunk, marker + index) !== suffix[index]) {
        suffixMatches = false;
        break;
      }
    }
    if (!suffixMatches) continue;
    let start = marker;
    while (
      start > 0 &&
      marker - start < 128 &&
      isIotHostnameByte(virtualByte(prefix, chunk, start - 1))
    ) {
      start -= 1;
    }
    if (start > 0 && isIotHostnameByte(virtualByte(prefix, chunk, start - 1)))
      continue;
    const endpointBytes = new Uint8Array(marker + suffix.byteLength - start);
    for (let index = 0; index < endpointBytes.byteLength; index += 1) {
      const value = virtualByte(prefix, chunk, start + index);
      if (value === undefined) throw new Error("DEX stream ended unexpectedly");
      endpointBytes[index] = value;
    }
    const endpoint = new TextDecoder("latin1").decode(endpointBytes);
    if (isAwsIotEndpointForRegion(endpoint, region)) {
      candidateBudget.count += 1;
      if (candidateBudget.count > MAX_IOT_ENDPOINT_CANDIDATES) {
        throw new Error("DEX contains too many AWS IoT endpoint candidates");
      }
      if (isTrustedDiscoveredIotEndpoint(endpoint)) return endpoint;
    }
  }
  return undefined;
}

function virtualByte(
  prefix: Uint8Array,
  chunk: Uint8Array,
  index: number,
): number | undefined {
  return index < prefix.byteLength
    ? prefix[index]
    : chunk[index - prefix.byteLength];
}

function copyVirtualTail(
  prefix: Uint8Array,
  chunk: Uint8Array,
  maximumBytes: number,
): Uint8Array {
  const total = prefix.byteLength + chunk.byteLength;
  const length = Math.min(total, maximumBytes);
  const tail = new Uint8Array(length);
  const start = total - length;
  for (let index = 0; index < length; index += 1) {
    const value = virtualByte(prefix, chunk, start + index);
    if (value === undefined) throw new Error("DEX stream ended unexpectedly");
    tail[index] = value;
  }
  return tail;
}

function isIotHostnameByte(value: number | undefined): boolean {
  return (
    value === 0x2d ||
    (value !== undefined && value >= 0x30 && value <= 0x39) ||
    (value !== undefined && value >= 0x61 && value <= 0x7a)
  );
}

async function downloadResponseToTemporaryFile(
  response: DownloadResponseSnapshot,
  maximumBytes: number,
  description: string,
  signal: AbortSignal,
): Promise<{ directory: string; path: string }> {
  const contentLength = readContentLength(
    readDownloadHeader(response, "content-length"),
  );
  if (contentLength !== undefined && contentLength > maximumBytes) {
    cancelResponseBody(response);
    throw new Error(`${description} exceeds the size limit`);
  }
  const directory = await mkdtemp(join(tmpdir(), "cradlewise-download-"));
  const path = join(directory, "response.bin");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    if (!response.body?.getReader) {
      const rawBuffer: unknown = await raceWithAbort(
        response.arrayBuffer(),
        signal,
        () => cancelResponseBody(response),
      );
      const byteLength = getArrayBufferByteLength(rawBuffer);
      if (byteLength === undefined) {
        throw new TypeError(`${description} returned an invalid body buffer`);
      }
      if (byteLength > maximumBytes) {
        throw new Error(`${description} exceeds the size limit`);
      }
      await writeAll(handle, new Uint8Array(rawBuffer as ArrayBuffer));
      await handle.close();
      handle = undefined;
      return { directory, path };
    }

    const reader = response.body.getReader();
    let total = 0;
    let chunkCount = 0;
    let canceled = false;
    const cancelReader = (): void => {
      if (canceled) return;
      canceled = true;
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        return;
      }
    };
    try {
      while (true) {
        const chunk = snapshotDownloadChunk(
          await raceWithAbort(reader.read(), signal, cancelReader),
        );
        if (chunk.done) break;
        chunkCount += 1;
        if (chunkCount > MAX_RESPONSE_CHUNKS) {
          cancelReader();
          throw new Error(`${description} has too many chunks`);
        }
        total += chunk.value.byteLength;
        if (total > maximumBytes) {
          cancelReader();
          throw new Error(`${description} exceeds the size limit`);
        }
        await writeAll(handle, chunk.value);
      }
    } catch (error) {
      cancelReader();
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        void error;
      }
    }
    await handle.close();
    handle = undefined;
    return { directory, path };
  } catch (error) {
    return rethrowWithConfigCleanups(
      error,
      [
        async () => {
          if (handle) await handle.close();
        },
        () => rm(directory, { recursive: true, force: true }),
      ],
      `${description} and cleanup failed`,
    );
  }
}

export async function rethrowWithConfigCleanups(
  primaryError: unknown,
  cleanups: Array<() => Promise<unknown>>,
  message: string,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], message, {
      cause: primaryError,
    });
  }
  throw primaryError;
}

async function readResponseBytes(
  response: DownloadResponseSnapshot,
  maximumBytes: number,
  description: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = readContentLength(
    readDownloadHeader(response, "content-length"),
  );
  if (contentLength !== undefined && contentLength > maximumBytes) {
    cancelResponseBody(response);
    throw new Error(`${description} exceeds the size limit`);
  }
  if (!response.body?.getReader) {
    const buffer = await raceWithAbort(response.arrayBuffer(), signal, () => {
      cancelResponseBody(response);
    });
    const byteLength = getArrayBufferByteLength(buffer);
    if (byteLength === undefined) {
      throw new TypeError(`${description} returned an invalid body buffer`);
    }
    if (byteLength > maximumBytes) {
      throw new Error(`${description} exceeds the size limit`);
    }
    return new Uint8Array(buffer as ArrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  let temporaryDirectory: string | undefined;
  let temporaryPath: string | undefined;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let canceled = false;
  const cancelReader = (): void => {
    if (canceled) return;
    canceled = true;
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      return;
    }
  };
  return withCleanupOperations(
    async () => {
      try {
        while (true) {
          const chunk = snapshotDownloadChunk(
            await raceWithAbort(reader.read(), signal, () => {
              cancelReader();
            }),
          );
          if (chunk.done) break;
          const { value } = chunk;
          chunkCount += 1;
          if (chunkCount > MAX_RESPONSE_CHUNKS) {
            cancelReader();
            throw new Error(`${description} has too many chunks`);
          }
          total += value.byteLength;
          if (total > maximumBytes) {
            cancelReader();
            throw new Error(`${description} exceeds the size limit`);
          }
          if (!temporaryHandle && total > MAX_IN_MEMORY_RESPONSE_BYTES) {
            temporaryDirectory = await mkdtemp(
              join(tmpdir(), "cradlewise-download-"),
            );
            temporaryPath = join(temporaryDirectory, "response.bin");
            temporaryHandle = await open(temporaryPath, "wx+", 0o600);
            for (const chunk of chunks) {
              await writeAll(temporaryHandle, chunk);
            }
            chunks.length = 0;
          }
          if (temporaryHandle) {
            await writeAll(temporaryHandle, value);
          } else {
            chunks.push(value);
          }
        }
      } catch (error) {
        cancelReader();
        throw error;
      } finally {
        try {
          reader.releaseLock();
        } catch (error) {
          void error;
        }
      }
      if (temporaryHandle && temporaryPath) {
        await temporaryHandle.close();
        temporaryHandle = undefined;
        return await readFile(temporaryPath);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
    [
      async () => {
        if (temporaryHandle) {
          await temporaryHandle.close();
          temporaryHandle = undefined;
        }
      },
      async () => {
        if (temporaryDirectory) {
          await rm(temporaryDirectory, { force: true, recursive: true });
        }
      },
    ],
    `${description} processing and cleanup failed`,
  );
}

function readContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || (value.length > 1 && value[0] === "0")) {
    throw new TypeError("Response content-length header is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index);
    if (characterCode < 48 || characterCode > 57) {
      throw new TypeError("Response content-length header is invalid");
    }
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Response content-length header is invalid");
  }
  return parsed;
}

interface DownloadResponseSnapshot {
  status: number;
  ok: boolean;
  body: DownloadBodySnapshot | null;
  getHeader(name: string): unknown;
  arrayBuffer(): Promise<unknown>;
}

interface DownloadBodySnapshot {
  getReader?: () => DownloadReaderSnapshot;
  cancel?: () => Promise<unknown>;
}

interface DownloadReaderSnapshot {
  read(): Promise<unknown>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}

function snapshotDownloadResponse(
  value: unknown,
): DownloadResponseSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const status = value.status;
    const ok = value.ok;
    const headers = value.headers;
    const body = value.body;
    const arrayBuffer = value.arrayBuffer;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      ok !== (status >= 200 && status <= 299) ||
      !isRecord(headers) ||
      typeof arrayBuffer !== "function" ||
      (body !== null && body !== undefined && !isRecord(body))
    ) {
      return undefined;
    }
    const getHeader = headers.get;
    if (typeof getHeader !== "function") return undefined;
    const bodySnapshot = snapshotDownloadBody(body);
    if (body !== null && body !== undefined && !bodySnapshot) return undefined;
    return {
      status,
      ok,
      body: bodySnapshot,
      getHeader: (name: string): unknown => {
        const result: unknown = Reflect.apply(getHeader, headers, [name]);
        return result;
      },
      arrayBuffer: () => {
        const result: unknown = Reflect.apply(arrayBuffer, value, []);
        return Promise.resolve(result);
      },
    };
  } catch {
    return undefined;
  }
}

function snapshotDownloadBody(value: unknown): DownloadBodySnapshot | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const getReader = value.getReader;
  const cancel = value.cancel;
  if (getReader !== undefined && typeof getReader !== "function") return null;
  if (cancel !== undefined && typeof cancel !== "function") return null;
  return {
    ...(typeof getReader === "function"
      ? {
          getReader: (): DownloadReaderSnapshot =>
            snapshotDownloadReader(Reflect.apply(getReader, value, [])),
        }
      : {}),
    ...(typeof cancel === "function"
      ? {
          cancel: (): Promise<unknown> =>
            Promise.resolve(Reflect.apply(cancel, value, [])),
        }
      : {}),
  };
}

function snapshotDownloadReader(value: unknown): DownloadReaderSnapshot {
  if (!isRecord(value)) {
    throw new TypeError("Download response returned an invalid stream reader");
  }
  const read = value.read;
  const cancel = value.cancel;
  const releaseLock = value.releaseLock;
  if (
    typeof read !== "function" ||
    typeof cancel !== "function" ||
    typeof releaseLock !== "function"
  ) {
    throw new TypeError("Download response returned an invalid stream reader");
  }
  return {
    read: () => Promise.resolve(Reflect.apply(read, value, [])),
    cancel: () => Promise.resolve(Reflect.apply(cancel, value, [])),
    releaseLock: () => {
      Reflect.apply(releaseLock, value, []);
    },
  };
}

function snapshotDownloadChunk(
  value: unknown,
): { done: true } | { done: false; value: Uint8Array } {
  if (!isRecord(value)) {
    throw new TypeError("Download response returned an invalid stream chunk");
  }
  const done = value.done;
  const chunk = value.value;
  const bytes = done === false ? snapshotUint8Array(chunk) : undefined;
  if (typeof done !== "boolean" || (!done && !bytes)) {
    throw new TypeError("Download response returned an invalid stream chunk");
  }
  return done ? { done: true } : { done: false, value: bytes as Uint8Array };
}

function readDownloadHeader(
  response: DownloadResponseSnapshot,
  name: string,
): string | undefined {
  const value = response.getHeader(name);
  if (value === null || value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    utf8ByteLength(value, 8192) > 8192 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`Response header ${name} is invalid`);
  }
  return value;
}

function cancelResponseBody(response: {
  readonly body?: DownloadBodySnapshot | null;
}): void {
  try {
    const cancellation = response.body?.cancel?.();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    return;
  }
}

function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  onAbort?: () => void,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    try {
      onAbort?.();
    } catch {
      return Promise.reject(abortReason(signal));
    }
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => {
      try {
        onAbort?.();
      } catch {
        return finish(() => reject(abortReason(signal)));
      }
      finish(() => reject(abortReason(signal)));
    };
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

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes.subarray(offset));
    if (bytesWritten <= 0) throw new Error("Unable to spool response body");
    offset += bytesWritten;
  }
}

function requireString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value, MAX_CONFIG_STRING_BYTES) > MAX_CONFIG_STRING_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new CradlewiseConfigError(
      `Missing or invalid app configuration field: ${field}`,
    );
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized === "undefined" ||
    normalized === "null"
  ) {
    throw new CradlewiseConfigError(
      `Missing or invalid app configuration field: ${field}`,
    );
  }
  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field);
}

function isRecord<T extends object>(
  value: T,
): value is T & Record<string, unknown>;
function isRecord(value: unknown): value is Record<string, unknown>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function requireAwsRegion(value: unknown): string {
  const region = requireString(value, "cognitoRegion");
  if (!/^[a-z]{2,4}(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw new CradlewiseConfigError(
      "cognitoRegion must be a valid AWS region identifier",
    );
  }
  return region;
}

export function isAwsIotEndpointForRegion(
  value: unknown,
  region: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    typeof region !== "string" ||
    value.length === 0 ||
    value.length > MAX_CONFIG_STRING_BYTES ||
    region.length > 255 ||
    utf8ByteLength(value, MAX_CONFIG_STRING_BYTES) > MAX_CONFIG_STRING_BYTES ||
    value !== value.trim() ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    !/^[a-z]{2,4}(?:-[a-z0-9]+)+-\d+$/.test(region)
  ) {
    return false;
  }
  const escapedRegion = escapeRegExp(region);
  return new RegExp(
    `^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,57}[a-z0-9])-ats\\.iot\\.${escapedRegion}\\.amazonaws\\.com$`,
  ).test(value);
}

export function isApiBaseUrlForRegion(
  value: unknown,
  region: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    typeof region !== "string" ||
    value.length === 0 ||
    value.length > MAX_CONFIG_STRING_BYTES ||
    region.length > 255 ||
    utf8ByteLength(value, MAX_CONFIG_STRING_BYTES) > MAX_CONFIG_STRING_BYTES ||
    value !== value.trim() ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    !/^[a-z]{2,4}(?:-[a-z0-9]+)+-\d+$/.test(region)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  const escapedRegion = escapeRegExp(region);
  return (
    url.hostname === "backend.cradlewise.com" ||
    new RegExp(
      `^[a-z0-9]+\\.execute-api\\.${escapedRegion}\\.amazonaws\\.com$`,
    ).test(url.hostname)
  );
}

function optionalIotEndpoint(
  value: unknown,
  region: string,
): string | undefined {
  const endpoint = optionalString(value, "iotEndpoint");
  if (endpoint === undefined) return undefined;
  if (!isAwsIotEndpointForRegion(endpoint, region)) {
    throw new CradlewiseConfigError(
      "iotEndpoint must be an AWS IoT ATS hostname in the configured Cognito region",
    );
  }
  return endpoint;
}

function requireApiBaseUrl(value: unknown, region: string): string {
  const raw = requireString(value, "apiBaseUrl");
  if (!isApiBaseUrlForRegion(raw, region)) {
    throw new CradlewiseConfigError(
      "apiBaseUrl must be an HTTPS Cradlewise backend or regional API Gateway URL without credentials, query, or fragment",
    );
  }
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new Error(`Expected string field: ${field}`);
  return value;
}
