import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { aggregateSleepAnalytics, parseEventTime } from "./analytics.js";
import type { CradlewiseAuth } from "./auth.js";
import { snapshotUint8Array } from "./byte-utils.js";
import { isApiBaseUrlForRegion } from "./config.js";
import { getDateTime } from "./date-utils.js";
import { CradlewiseApiError } from "./errors.js";
import { Cradle } from "./models.js";
import type { SleepAnalytics } from "./models.js";
import { utf8ByteLength } from "./text-utils.js";
import type {
  BabyProfile,
  CradleRecord,
  CradlePhoto,
  CradleState,
  CradlewiseAwsCredentials,
  CradlewiseClientOptions,
  InboxMessage,
  InboxMessagesResponse,
  JsonObject,
  SleepAnalyticsResponse,
  SleepAnalyticsQuery,
  SleepDataRangeOptions,
  SleepEvent,
  SleepEventsResponse,
  UserDevicesResponse,
} from "./types.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_DISCOVERY_CONCURRENCY = 8;
const MAX_DISCOVERY_RECORDS = 100;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 1_000_000;
const MAX_SLEEP_RECORDS = 100_000;
const MAX_INBOX_RECORDS = 100;
const MAX_USER_DEVICE_RECORDS = 100;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 8192;
const MAX_DATE_INPUT_BYTES = 64;
const MAX_HTTP_METHOD_LENGTH = 32;
const MAX_PATH_BYTES = 8192;
const MAX_QUERY_PARAMETERS = 100;
const MAX_QUERY_NAME_BYTES = 256;
const MAX_QUERY_PARAMETER_BYTES = 8192;
const MAX_QUERY_STRING_BYTES = 64 * 1024;
const MAX_QUERY_VALUE_BYTES = 256;
const MAX_TIMEZONE_BYTES = 255;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_DISPLAY_STRING_BYTES = 4096;
const MAX_EMBEDDED_JSON_BYTES = 1024 * 1024;

export class CradlewiseClient {
  readonly auth: CradlewiseAuth;
  readonly cradles = new Map<string, Cradle>();
  readonly analytics = new Map<string, SleepAnalytics>();
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #allowStateChangingRequests: boolean;
  readonly #ensureValid: () => Promise<unknown>;
  readonly #authenticate: () => Promise<unknown>;
  readonly #apiBaseUrl: string;
  readonly #cradleUpdateGenerations = new WeakMap<Cradle, symbol>();
  readonly #analyticsGenerations = new Map<string, symbol>();
  #discovery: Promise<Map<string, Cradle>> | undefined;
  #authenticationRefresh: Promise<void> | undefined;
  readonly #cognitoRegion: string;
  readonly #email: string;

  constructor(auth: CradlewiseAuth, options: CradlewiseClientOptions = {}) {
    const authSnapshot = readClientAuthSnapshot(auth);
    if (!authSnapshot) {
      throw new TypeError("auth must be a CradlewiseAuth-compatible object");
    }
    if (!isPlainObject(options)) {
      throw new TypeError("options must be an object");
    }
    const fetchImplementation = options.fetch;
    const userAgent = options.userAgent;
    const requestTimeoutMs = options.requestTimeoutMs;
    const maxResponseBytes = options.maxResponseBytes;
    const allowStateChangingRequests = options.allowStateChangingRequests;
    if (
      fetchImplementation !== undefined &&
      typeof fetchImplementation !== "function"
    ) {
      throw new TypeError("fetch must be a function");
    }
    if (
      userAgent !== undefined &&
      (typeof userAgent !== "string" ||
        userAgent.length === 0 ||
        userAgent.length > MAX_USER_AGENT_LENGTH ||
        userAgent !== userAgent.trim() ||
        hasInvalidHeaderCharacter(userAgent))
    ) {
      throw new TypeError(
        "userAgent must be a nonempty trimmed printable ASCII string",
      );
    }
    if (
      allowStateChangingRequests !== undefined &&
      typeof allowStateChangingRequests !== "boolean"
    ) {
      throw new TypeError("allowStateChangingRequests must be a boolean");
    }
    this.auth = auth;
    Object.defineProperty(this, "auth", {
      configurable: false,
      enumerable: true,
      writable: false,
    });
    this.#fetch = fetchImplementation ?? globalThis.fetch;
    this.#ensureValid = authSnapshot.ensureValid;
    this.#authenticate = authSnapshot.authenticate;
    this.#userAgent = userAgent ?? `${PACKAGE_NAME}-js/${PACKAGE_VERSION}`;
    this.#requestTimeoutMs = requestTimeoutMs ?? 30_000;
    this.#maxResponseBytes = maxResponseBytes ?? 16 * 1024 * 1024;
    this.#allowStateChangingRequests = allowStateChangingRequests ?? false;
    const configuredUrl = new URL(authSnapshot.apiBaseUrl);
    this.#apiBaseUrl = `${configuredUrl.origin}${configuredUrl.pathname.replace(/\/+$/, "")}`;
    this.#cognitoRegion = authSnapshot.cognitoRegion;
    this.#email = authSnapshot.email;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0 ||
      this.#requestTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError(
        "requestTimeoutMs must be a positive integer no greater than 2147483647",
      );
    }
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes <= 0 ||
      this.#maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new RangeError(
        "maxResponseBytes must be a positive integer no greater than 67108864",
      );
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<T> {
    if (
      typeof method !== "string" ||
      method.length === 0 ||
      method.length > MAX_HTTP_METHOD_LENGTH ||
      method !== method.trim() ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)
    ) {
      throw new TypeError("method must be a nonempty HTTP token");
    }
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      utf8ByteLength(path, MAX_PATH_BYTES) > MAX_PATH_BYTES
    ) {
      throw new TypeError("path must be a nonempty string");
    }
    if (hasPathDotSegment(path)) {
      throw new RangeError("path must not contain dot segments");
    }
    if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
      throw new RangeError("path must not contain malformed percent escapes");
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      throw new RangeError("path must contain valid UTF-8 percent escapes");
    }
    if (hasControlCharacter(decodedPath)) {
      throw new RangeError("path must not contain encoded controls");
    }
    if (
      /%(?:23|25|2[fF]|3[fF]|5[cC]|0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[fF])/.test(path)
    ) {
      throw new RangeError(
        "path must not contain encoded delimiters, percent signs, separators, or controls",
      );
    }
    if (path.includes("\\") || hasControlCharacter(path)) {
      throw new RangeError("path must not contain backslashes or controls");
    }
    if (path.includes("#")) {
      throw new RangeError("path must not contain a URL fragment");
    }
    if (path.includes("?")) {
      throw new RangeError(
        "path must not contain a query string; use options.query",
      );
    }
    if (!isPlainObject(options)) {
      throw new TypeError("options must be an object");
    }
    const body = options.body;
    const queryInput = options.query;
    if (queryInput !== undefined && !isPlainObject(queryInput)) {
      throw new TypeError("options.query must be an object");
    }
    const queryParameters = new URLSearchParams();
    let queryParameterCount = 0;
    for (const key in queryInput ?? {}) {
      if (!Object.hasOwn(queryInput ?? {}, key)) continue;
      queryParameterCount += 1;
      if (queryParameterCount > MAX_QUERY_PARAMETERS) {
        throw new RangeError("options.query must not exceed 100 parameters");
      }
      const value: unknown = queryInput?.[key];
      if (
        key.length === 0 ||
        utf8ByteLength(key, MAX_QUERY_NAME_BYTES) > MAX_QUERY_NAME_BYTES ||
        key !== key.trim() ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        hasControlCharacter(key)
      ) {
        throw new TypeError(
          "Query parameter names must be nonempty trimmed control-free strings",
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        (typeof value !== "number" || !Number.isFinite(value))
      ) {
        throw new TypeError(
          `Query parameter ${key || "(empty)"} must be a string, boolean, or finite number`,
        );
      }
      if (
        typeof value === "string" &&
        (utf8ByteLength(value, MAX_QUERY_PARAMETER_BYTES) >
          MAX_QUERY_PARAMETER_BYTES ||
          hasControlCharacter(value))
      ) {
        throw new TypeError(
          `Query parameter ${key} must not contain control characters or exceed 8192 bytes`,
        );
      }
      queryParameters.append(key, String(value));
    }
    const queryString = queryParameters.toString();
    if (
      utf8ByteLength(queryString, MAX_QUERY_STRING_BYTES) >
      MAX_QUERY_STRING_BYTES
    ) {
      throw new RangeError("options.query must not exceed 65536 encoded bytes");
    }
    const normalizedMethod = method.toUpperCase();
    if (
      normalizedMethod !== "GET" &&
      normalizedMethod !== "HEAD" &&
      !this.#allowStateChangingRequests
    ) {
      throw new CradlewiseApiError(
        `HTTP ${normalizedMethod || "(empty)"} is disabled by the read-only client boundary. Set allowStateChangingRequests only after independently verifying the endpoint.`,
      );
    }
    if (
      body !== undefined &&
      (normalizedMethod === "GET" || normalizedMethod === "HEAD")
    ) {
      throw new CradlewiseApiError(
        `HTTP ${normalizedMethod} requests must not include a body`,
      );
    }
    const requestSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    return this.#request<T>(
      normalizedMethod,
      path,
      {
        ...(body === undefined ? {} : { body }),
        ...(queryString.length === 0 ? {} : { queryString }),
      },
      normalizedMethod === "GET" || normalizedMethod === "HEAD",
      requestSignal,
    );
  }

  async getBabyProfiles(): Promise<BabyProfile[]> {
    const data = await this.request<unknown>("GET", "/babyProfiles/forEmail", {
      query: { email_id: this.#email },
    });
    const profiles = Array.isArray(data)
      ? data
      : isObject(data) && Array.isArray(data.user_list)
        ? data.user_list
        : undefined;
    if (
      profiles !== undefined &&
      profiles.length <= MAX_DISCOVERY_RECORDS &&
      profiles?.every(
        (profile) =>
          isObject(profile) &&
          isIdentifier(profile.baby_id ?? profile.id) &&
          (profile.name === undefined ||
            profile.name === null ||
            isSafeDisplayString(profile.name)),
      )
    ) {
      return profiles as BabyProfile[];
    }
    throw unexpectedResponse("babyProfiles/forEmail", data);
  }

  async getCradlesForBaby(babyId: string | number): Promise<CradleRecord[]> {
    const data = await this.request<unknown>(
      "GET",
      `/babyProfiles/${encodePathIdentifier(babyId, "babyId")}/cradles`,
    );
    const records = Array.isArray(data)
      ? data
      : isObject(data) && Array.isArray(data.cradle_list)
        ? data.cradle_list
        : undefined;
    if (
      records !== undefined &&
      records.length <= MAX_DISCOVERY_RECORDS &&
      records?.every(
        (record) =>
          isObject(record) &&
          typeof record.cradle_id === "string" &&
          isIdentifier(record.cradle_id) &&
          (record.timezone === undefined ||
            record.timezone === null ||
            (typeof record.timezone === "string" &&
              isValidTimeZone(record.timezone))),
      )
    ) {
      return records as CradleRecord[];
    }
    throw unexpectedResponse("baby profile cradles", data);
  }

  async discoverCradles(): Promise<Map<string, Cradle>> {
    if (!this.#discovery) {
      const discovery = this.#performDiscovery();
      const tracked = discovery.finally(() => {
        if (this.#discovery === tracked) this.#discovery = undefined;
      });
      this.#discovery = tracked;
    }
    return this.#discovery;
  }

  async #performDiscovery(): Promise<Map<string, Cradle>> {
    const profiles = await this.getBabyProfiles();
    const discovered = new Map<string, Cradle>();
    const existingUpdates: Array<{
      cradle: Cradle;
      babyId: string;
      babyName: string;
      timezone: string | undefined;
    }> = [];
    const profileCradles: Array<{
      profile: BabyProfile;
      babyId: string | number;
      records: CradleRecord[];
    }> = [];
    for (
      let offset = 0;
      offset < profiles.length;
      offset += MAX_DISCOVERY_CONCURRENCY
    ) {
      const batch = profiles.slice(offset, offset + MAX_DISCOVERY_CONCURRENCY);
      profileCradles.push(
        ...(await Promise.all(
          batch.map(async (profile) => {
            const babyId = profile.baby_id ?? profile.id;
            if (!isIdentifier(babyId)) {
              throw unexpectedResponse("babyProfiles/forEmail", profile);
            }
            const records = await this.getCradlesForBaby(babyId);
            return { profile, babyId, records };
          }),
        )),
      );
    }
    for (const { profile, babyId, records } of profileCradles) {
      for (const record of records) {
        const cradleId = record.cradle_id;
        if (!isIdentifier(cradleId)) {
          throw unexpectedResponse("baby profile cradles", record);
        }
        if (discovered.has(cradleId)) continue;
        if (discovered.size >= MAX_DISCOVERY_RECORDS) {
          throw new CradlewiseApiError(
            "Cradlewise discovery returned more than 100 unique cribs",
          );
        }
        const existing = this.cradles.get(cradleId);
        if (existing instanceof Cradle && existing.cradleId === cradleId) {
          existingUpdates.push({
            cradle: existing,
            babyId: String(babyId),
            babyName: profile.name ?? "Baby",
            timezone: record.timezone ?? undefined,
          });
          discovered.set(cradleId, existing);
          continue;
        }
        discovered.set(
          cradleId,
          new Cradle({
            cradleId,
            babyId: String(babyId),
            babyName: profile.name ?? "Baby",
            ...(record.timezone ? { timezone: record.timezone } : {}),
          }),
        );
      }
    }
    for (const update of existingUpdates) {
      update.cradle.babyId = update.babyId;
      update.cradle.babyName = update.babyName;
      update.cradle.timezone = update.timezone;
    }
    this.cradles.clear();
    for (const [id, cradle] of discovered) this.cradles.set(id, cradle);
    return this.cradles;
  }

  async getCradleState(cradleId: string): Promise<CradleState> {
    const result = await this.request<unknown>(
      "GET",
      `/cradles/${encodePathIdentifier(cradleId, "cradleId")}/state`,
    );
    if (
      isObject(result) &&
      hasOwnAny(result, [
        "babyPresent",
        "baby_present",
        "babySleepState",
        "baby_sleep_state",
        "babySleepPhase",
        "babySleepPhaseV2",
        "rawShadow",
        "actuator",
        "music",
        "soundSynth",
        "light",
        "deviceStatus",
        "mode",
        "userSetCradleMode",
        "detectedCradleMode",
        "bounceMode",
        "bounceSetting",
        "bounce_setting",
        "responsivitySetting",
        "responsivity_setting",
        "rootfs_version",
      ])
    ) {
      return result as CradleState;
    }
    throw unexpectedResponse("cradle state", result);
  }

  async getCradleOnlineStatus(cradleId: string): Promise<JsonObject> {
    const result = await this.request<unknown>(
      "GET",
      `/cradles/${encodePathIdentifier(cradleId, "cradleId")}/onlineStatus/v2`,
    );
    if (
      isObject(result) &&
      hasOwnAny(result, ["online", "state_message"]) &&
      (result.online === undefined || typeof result.online === "boolean") &&
      (result.state_message === undefined ||
        result.state_message === null ||
        (typeof result.state_message === "string" &&
          utf8ByteLength(result.state_message, MAX_EMBEDDED_JSON_BYTES) <=
            MAX_EMBEDDED_JSON_BYTES)) &&
      (result.state_message_time === undefined ||
        result.state_message_time === null ||
        (typeof result.state_message_time === "string" &&
          utf8ByteLength(result.state_message_time, MAX_DATE_INPUT_BYTES) <=
            MAX_DATE_INPUT_BYTES &&
          !hasControlCharacter(result.state_message_time))) &&
      readOnlineState(result as JsonObject) !== undefined
    ) {
      return result as JsonObject;
    }
    throw unexpectedResponse("cradle online status", result);
  }

  async getFirmwareData(cradleId: string): Promise<JsonObject> {
    const result = await this.request<unknown>(
      "GET",
      `/cradles/${encodePathIdentifier(cradleId, "cradleId")}/firmwareData`,
    );
    if (
      isObject(result) &&
      hasOwnAny(result, [
        "version",
        "firmware_version",
        "rootfs_version",
        "serial_number",
        "last_firmware_updated",
      ]) &&
      [
        result.version,
        result.firmware_version,
        result.rootfs_version,
        result.serial_number,
        result.last_firmware_updated,
      ].every(
        (value) =>
          value === undefined || value === null || isSafeDisplayString(value),
      )
    ) {
      return result as JsonObject;
    }
    throw unexpectedResponse("firmware data", result);
  }

  async updateCradle(cradle: Cradle): Promise<Cradle> {
    requireCradle(cradle);
    const generation = Symbol();
    this.#cradleUpdateGenerations.set(cradle, generation);
    const [state, online, firmware] = await Promise.allSettled([
      this.getCradleState(cradle.cradleId),
      this.getCradleOnlineStatus(cradle.cradleId),
      this.getFirmwareData(cradle.cradleId),
    ]);
    if (this.#cradleUpdateGenerations.get(cradle) !== generation) return cradle;
    cradle.unavailableStatusSources = [
      ...(state.status === "rejected" ? (["state"] as const) : []),
      ...(online.status === "rejected" ? (["online"] as const) : []),
      ...(firmware.status === "rejected" ? (["firmware"] as const) : []),
    ];
    if (
      state.status === "rejected" &&
      online.status === "rejected" &&
      firmware.status === "rejected"
    ) {
      throw new CradlewiseApiError(
        `Unable to update crib ${cradle.cradleId} from any status endpoint`,
        {
          cause: new AggregateError([
            state.reason,
            online.reason,
            firmware.reason,
          ]),
        },
      );
    }
    if (state.status === "fulfilled") {
      cradle.replaceState(state.value);
    }
    if (online.status === "fulfilled") {
      const onlineState = readOnlineState(online.value);
      if (onlineState !== undefined) cradle.online = onlineState;
    }
    if (firmware.status === "fulfilled") {
      const version =
        firmware.value.version ??
        firmware.value.firmware_version ??
        firmware.value.rootfs_version;
      cradle.firmwareVersion =
        typeof version === "string" ? version : cradle.firmwareVersion;
      const serialNumber = firmware.value.serial_number;
      cradle.serialNumber =
        typeof serialNumber === "string" ? serialNumber : cradle.serialNumber;
    }
    return cradle;
  }

  async getSleepEventsData(
    babyId: string,
    options: SleepDataRangeOptions = {},
  ): Promise<SleepEventsResponse> {
    const range = resolveSleepRange(options);
    const result = await this.request<unknown>(
      "GET",
      `/babyProfiles/${encodePathIdentifier(babyId, "babyId")}/eventsV3`,
      {
        query: {
          start_date: range.startDate,
          end_date: range.endDate,
          tz: range.timezone,
        },
      },
    );
    if (isSleepEventArray(result)) {
      return { events: result };
    }
    if (
      isObject(result) &&
      hasOwnAny(result, ["events", "timezone", "sleep_sessions_saved"]) &&
      (result.events === undefined ||
        result.events === null ||
        isSleepEventArray(result.events)) &&
      (result.timezone === undefined ||
        result.timezone === null ||
        (typeof result.timezone === "string" &&
          isValidTimeZone(result.timezone))) &&
      (result.sleep_sessions_saved === undefined ||
        result.sleep_sessions_saved === null ||
        (Array.isArray(result.sleep_sessions_saved) &&
          result.sleep_sessions_saved.length <= MAX_SLEEP_RECORDS &&
          result.sleep_sessions_saved.every(
            (value) =>
              typeof value === "string" &&
              utf8ByteLength(value, MAX_DATE_INPUT_BYTES) <=
                MAX_DATE_INPUT_BYTES &&
              Number.isFinite(parseEventTime(value)),
          )))
    ) {
      const normalized: SleepEventsResponse = {
        ...result,
        events: isSleepEventArray(result.events) ? result.events : [],
      };
      if (normalized.timezone === null) delete normalized.timezone;
      if (normalized.sleep_sessions_saved === null) {
        delete normalized.sleep_sessions_saved;
      }
      return normalized;
    }
    throw unexpectedResponse("eventsV3", result);
  }

  async getSleepEvents(
    babyId: string,
    options: SleepDataRangeOptions = {},
  ): Promise<SleepEvent[]> {
    return (await this.getSleepEventsData(babyId, options)).events;
  }

  async getAnalytics(
    babyId: string,
    options: SleepAnalyticsQuery | number = {},
  ): Promise<SleepAnalyticsResponse> {
    const normalized =
      typeof options === "number" ? { startHour: options } : options;
    const range = resolveSleepRange(normalized);
    const { startHour, metricName, metricFilter } =
      validateAnalyticsQuery(normalized);
    const result = await this.request<unknown>(
      "GET",
      `/babyProfiles/${encodePathIdentifier(babyId, "babyId")}/analyticsV3`,
      {
        query: {
          start_date: range.startDate,
          end_date: range.endDate,
          metric_name: metricName,
          tz: range.timezone,
          metric_filter: metricFilter,
          start_hour: startHour,
        },
      },
    );
    if (isSleepAnalyticsResponse(result)) {
      return result;
    }
    throw unexpectedResponse("analyticsV3", result);
  }

  async getStatusTimeline(
    babyId: string,
    cradleId: string,
  ): Promise<JsonObject> {
    const result = await this.request<unknown>(
      "GET",
      `/babyProfiles/${encodePathIdentifier(babyId, "babyId")}/status_timeline_v2/${encodePathIdentifier(cradleId, "cradleId")}`,
    );
    if (
      isObject(result) &&
      Array.isArray(result.status_list) &&
      result.status_list.length <= MAX_SLEEP_RECORDS &&
      result.status_list.every(isObject)
    ) {
      return result as JsonObject;
    }
    throw unexpectedResponse("status timeline", result);
  }

  async getInboxMessages(
    cradleId: string,
    babyId: string,
    pageSize = 50,
  ): Promise<InboxMessagesResponse> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError("pageSize must be an integer from 1 through 100");
    }
    const normalizedBabyId = requireQueryValue(babyId, "babyId");
    const normalizedCradleId = requireQueryValue(cradleId, "cradleId");
    const deviceIds = await this.getUserDeviceIds(normalizedBabyId);
    if (deviceIds.length === 0) {
      throw new CradlewiseApiError(
        "No registered Cradlewise app device is available for inbox access",
      );
    }
    let invalidDeviceError: CradlewiseApiError | undefined;
    for (const deviceId of deviceIds) {
      try {
        const result = await this.request<unknown>("GET", "/inbox/v2", {
          query: {
            device_id: deviceId,
            page_size: pageSize,
            tags: "baby",
            baby_id: normalizedBabyId,
            message_type: "baby",
            cradle_id: normalizedCradleId,
          },
        });
        if (!isInboxMessagesResponse(result)) {
          throw unexpectedResponse("inbox v2", result);
        }
        return result;
      } catch (error) {
        if (!isInvalidInboxDeviceError(error)) throw error;
        invalidDeviceError = error;
      }
    }
    throw (
      invalidDeviceError ??
      new CradlewiseApiError(
        "No registered Cradlewise app device is available for inbox access",
      )
    );
  }

  async getUserDeviceIds(babyId: string): Promise<string[]> {
    const result = await this.request<unknown>(
      "GET",
      `/babyProfiles/${encodePathIdentifier(babyId, "babyId")}/userDevices`,
      { query: { email_id: this.#email } },
    );
    if (!isUserDevicesResponse(result)) {
      throw unexpectedResponse("baby profile user devices", result);
    }
    const expectedEmail = this.#email.toLowerCase();
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const user of result.user_devices ?? []) {
      if (user.email_id?.trim().toLowerCase() !== expectedEmail) continue;
      for (const device of user.devices ?? []) {
        const deviceId = device.device_id;
        if (
          typeof deviceId !== "string" ||
          !isIdentifier(deviceId) ||
          seen.has(deviceId)
        ) {
          continue;
        }
        seen.add(deviceId);
        ids.push(deviceId);
      }
    }
    return ids;
  }

  async getLatestCribPhoto(
    cradleId: string,
    babyId: string,
  ): Promise<CradlePhoto | undefined> {
    const response = await this.getInboxMessages(cradleId, babyId);
    let firstPhoto: CradlePhoto | undefined;
    let latestPhoto: CradlePhoto | undefined;
    let latestTime = Number.NEGATIVE_INFINITY;
    for (const message of response.baby_notifications ?? []) {
      const url = inboxImageUrl(message);
      if (!url) continue;
      const photo = cribPhotoFromMessage(message, url);
      firstPhoto ??= photo;
      const messageTime =
        typeof message.message_time === "string"
          ? parseEventTime(message.message_time)
          : Number.NaN;
      if (Number.isFinite(messageTime) && messageTime > latestTime) {
        latestTime = messageTime;
        latestPhoto = photo;
      }
    }
    return latestPhoto ?? firstPhoto;
  }

  async fetchSleepAnalytics(
    cradle: Cradle,
    options: SleepAnalyticsQuery | number = {},
  ): Promise<SleepAnalytics> {
    requireCradle(cradle);
    const normalized =
      typeof options === "number" ? { startHour: options } : options;
    const range = resolveSleepRange(normalized);
    const query = validateAnalyticsQuery(normalized);
    if (!cradle.babyId) {
      throw new CradlewiseApiError(
        `Cannot fetch sleep analytics for crib ${cradle.cradleId} without a baby profile ID`,
      );
    }
    const babyId = cradle.babyId;
    const cradleTimezone = cradle.timezone;
    const generation = Symbol();
    this.#analyticsGenerations.set(babyId, generation);
    try {
      const [events, metrics] = await Promise.allSettled([
        this.getSleepEventsData(babyId, range),
        this.getAnalytics(babyId, { ...range, ...query }),
      ]);
      if (events.status === "rejected" && metrics.status === "rejected") {
        throw new CradlewiseApiError(
          "Unable to fetch sleep analytics from eventsV3 and analyticsV3",
          { cause: new AggregateError([events.reason, metrics.reason]) },
        );
      }
      const value = aggregateSleepAnalytics(
        events.status === "fulfilled" ? events.value.events : [],
        metrics.status === "fulfilled" ? metrics.value : undefined,
        toDate(range.endDate),
        events.status === "fulfilled"
          ? (events.value.timezone ?? cradleTimezone)
          : cradleTimezone,
        events.status === "fulfilled"
          ? events.value.sleep_sessions_saved
          : undefined,
        toDate(range.startDate),
      );
      value.unavailableSources = [
        ...(events.status === "rejected" ? (["events"] as const) : []),
        ...(metrics.status === "rejected" ? (["analytics"] as const) : []),
      ];
      if (this.#analyticsGenerations.get(babyId) === generation) {
        this.analytics.set(babyId, value);
      }
      return value;
    } finally {
      if (this.#analyticsGenerations.get(babyId) === generation) {
        this.#analyticsGenerations.delete(babyId);
      }
    }
  }

  async #request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      queryString?: string;
    },
    retryAuthentication: boolean,
    requestSignal: AbortSignal,
  ): Promise<T> {
    const url = new URL(
      `${this.#apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`,
    );
    if (options.queryString) url.search = options.queryString;
    let body: string | undefined;
    try {
      let values = 0;
      const sizeBudget = { bytes: 0 };
      body =
        options.body === undefined
          ? undefined
          : JSON.stringify(
              options.body,
              function (this: unknown, key: string, value: unknown) {
                values += 1;
                const isRoot = values === 1;
                if (values > MAX_JSON_NODES) {
                  throw new TypeError("request body contains too many values");
                }
                if (typeof value === "number" && !Number.isFinite(value)) {
                  throw new TypeError(
                    "request body contains a non-finite number",
                  );
                }
                sizeBudget.bytes += 1;
                if (!isRoot && !Array.isArray(this)) {
                  addJsonStringBytes(key, sizeBudget);
                  sizeBudget.bytes += 1;
                }
                if (typeof value === "string") {
                  addJsonStringBytes(value, sizeBudget);
                } else if (typeof value === "number") {
                  sizeBudget.bytes += String(value).length;
                } else if (value === null) {
                  sizeBudget.bytes += 4;
                } else if (typeof value === "boolean") {
                  sizeBudget.bytes += value ? 4 : 5;
                } else if (typeof value === "object") {
                  sizeBudget.bytes += 2;
                } else if (
                  Array.isArray(this) &&
                  (value === undefined ||
                    typeof value === "function" ||
                    typeof value === "symbol")
                ) {
                  sizeBudget.bytes += 4;
                }
                assertRequestBodySize(sizeBudget.bytes);
                return value;
              },
            );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        throw new CradlewiseApiError(
          `Cradlewise API ${method.toUpperCase()} ${url.pathname} request body exceeds the 16 MiB limit`,
          { cause: error },
        );
      }
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} request body is not JSON-serializable`,
        { cause: error },
      );
    }
    if (options.body !== undefined && body === undefined) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method} ${url.pathname} request body is not JSON-serializable`,
      );
    }
    if (
      body !== undefined &&
      Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES
    ) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} request body exceeds the 16 MiB limit`,
      );
    }
    let credentialsResult: unknown;
    try {
      credentialsResult = await raceWithAbort(
        this.#ensureValid(),
        requestSignal,
      );
    } catch (error) {
      if (!requestSignal.aborted) throw error;
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} timed out while acquiring credentials`,
        { cause: error },
      );
    }
    const credentials = readSigningCredentials(credentialsResult);
    if (!credentials) {
      throw new CradlewiseApiError(
        "Cradlewise authentication returned invalid AWS signing credentials",
      );
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const signer = new SignatureV4({
      credentials,
      region: this.#cognitoRegion,
      service: "execute-api",
      sha256: Sha256,
    });
    let signedHeaders: Record<string, string>;
    try {
      const signed = await raceWithAbort(
        signer.sign(
          new HttpRequest({
            method: method.toUpperCase(),
            protocol: url.protocol,
            hostname: url.hostname,
            ...(url.port ? { port: Number(url.port) } : {}),
            path: url.pathname,
            query,
            headers: {
              host: url.host,
              "content-type": "application/json",
              "user-agent": this.#userAgent,
            },
            ...(body === undefined ? {} : { body }),
          }),
        ),
        requestSignal,
      );
      signedHeaders = signed.headers;
    } catch (error) {
      throw new CradlewiseApiError(
        `Unable to sign Cradlewise API ${method.toUpperCase()} ${url.pathname} request`,
        { cause: error },
      );
    }
    let response: Response;
    try {
      response = await raceWithAbort(
        this.#fetch(url, {
          method: method.toUpperCase(),
          headers: signedHeaders,
          redirect: "error",
          ...(body === undefined ? {} : { body }),
          signal: requestSignal,
        }),
        requestSignal,
        undefined,
        (lateResponse) => {
          void cancelResponseBody(lateResponse);
        },
      );
    } catch (error) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} failed before receiving a response`,
        { cause: error },
      );
    }
    const responseSnapshot = snapshotResponse(response);
    if (!responseSnapshot) {
      if (isObject(response)) cancelResponseBody(response);
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} returned an invalid fetch response`,
        {
          cause: new TypeError("fetch must resolve to a Response-like object"),
        },
      );
    }

    if (
      (responseSnapshot.status === 401 || responseSnapshot.status === 403) &&
      retryAuthentication
    ) {
      cancelResponseSnapshot(responseSnapshot);
      let currentCredentials: CradlewiseAwsCredentials | undefined;
      try {
        currentCredentials = readSigningCredentials(this.auth.credentials);
      } catch {
        currentCredentials = undefined;
      }
      if (
        !currentCredentials ||
        (currentCredentials.accessKeyId === credentials.accessKeyId &&
          currentCredentials.sessionToken === credentials.sessionToken)
      ) {
        try {
          await raceWithAbort(this.#refreshAuthentication(), requestSignal);
        } catch (error) {
          if (!requestSignal.aborted) throw error;
          throw new CradlewiseApiError(
            `Cradlewise API ${method.toUpperCase()} ${url.pathname} timed out while refreshing credentials`,
            { status: responseSnapshot.status, cause: error },
          );
        }
      }
      return this.#request<T>(method, path, options, false, requestSignal);
    }

    let text: string;
    try {
      text = await readResponseText(
        responseSnapshot,
        this.#maxResponseBytes,
        requestSignal,
      );
    } catch (error) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} failed while reading the response body`,
        { status: responseSnapshot.status, cause: error },
      );
    }
    let requestId: string | undefined;
    try {
      requestId =
        readResponseHeader(responseSnapshot, "x-amzn-requestid") ??
        readResponseHeader(responseSnapshot, "x-amz-request-id");
    } catch (error) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} returned invalid response headers`,
        { status: responseSnapshot.status, cause: error },
      );
    }
    let responseBody: unknown;
    try {
      responseBody = parseResponseBody(text);
    } catch (error) {
      if (!responseSnapshot.ok) {
        throw new CradlewiseApiError(
          `Cradlewise API ${method.toUpperCase()} ${url.pathname} failed with HTTP ${responseSnapshot.status}`,
          {
            status: responseSnapshot.status,
            requestId,
            responseBody: text,
            cause: error,
          },
        );
      }
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} returned invalid JSON data`,
        {
          status: responseSnapshot.status,
          requestId,
          responseBody: text,
          cause: error,
        },
      );
    }
    if (!responseSnapshot.ok) {
      throw new CradlewiseApiError(
        `Cradlewise API ${method.toUpperCase()} ${url.pathname} failed with HTTP ${responseSnapshot.status}`,
        {
          status: responseSnapshot.status,
          requestId,
          responseBody,
        },
      );
    }
    return responseBody as T;
  }

  async #refreshAuthentication(): Promise<void> {
    if (!this.#authenticationRefresh) {
      const refresh = this.#authenticate().then(() => undefined);
      const tracked = refresh.finally(() => {
        if (this.#authenticationRefresh === tracked) {
          this.#authenticationRefresh = undefined;
        }
      });
      this.#authenticationRefresh = tracked;
    }
    await this.#authenticationRefresh;
  }
}

class RequestBodyTooLargeError extends RangeError {}

function assertRequestBodySize(bytes: number): void {
  if (bytes > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError("request body exceeds the 16 MiB limit");
  }
}

function addJsonStringBytes(value: string, budget: { bytes: number }): void {
  budget.bytes += 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      budget.bytes += 2;
    } else if (code <= 0x1f) {
      budget.bytes +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code <= 0x7f) {
      budget.bytes += 1;
    } else if (code <= 0x7ff) {
      budget.bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        budget.bytes += 4;
        index += 1;
      } else {
        budget.bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      budget.bytes += 6;
    } else {
      budget.bytes += 3;
    }
    assertRequestBodySize(budget.bytes);
  }
}

interface ResolvedSleepRange {
  startDate: string;
  endDate: string;
  timezone: string;
}

function validateAnalyticsQuery(options: SleepAnalyticsQuery): {
  startHour: number;
  metricName: string;
  metricFilter: string;
} {
  const requestedStartHour = options.startHour;
  const requestedMetricName = options.metricName;
  const requestedMetricFilter = options.metricFilter;
  const startHour = requestedStartHour === undefined ? 8 : requestedStartHour;
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new RangeError("startHour must be an integer from 0 through 23");
  }
  const metricName = requireQueryValue(
    requestedMetricName === undefined ? "sleep_metrics" : requestedMetricName,
    "metricName",
  );
  const metricFilter = requireQueryValue(
    requestedMetricFilter === undefined ? "app" : requestedMetricFilter,
    "metricFilter",
  );
  return { startHour, metricName, metricFilter };
}

function resolveSleepRange(options: SleepDataRangeOptions): ResolvedSleepRange {
  if (!isPlainObject(options)) {
    throw new TypeError("sleep data options must be a plain object");
  }
  const startDateInput = options.startDate;
  const endDateInput = options.endDate;
  const timezoneInput = options.timezone;
  for (const [field, value] of [
    ["startDate", startDateInput],
    ["endDate", endDateInput],
  ] as const) {
    if (
      value !== undefined &&
      typeof value !== "string" &&
      !(value instanceof Date)
    ) {
      throw new TypeError(`${field} must be a Date or string`);
    }
  }
  if (
    timezoneInput !== undefined &&
    (typeof timezoneInput !== "string" ||
      utf8ByteLength(timezoneInput, MAX_TIMEZONE_BYTES) > MAX_TIMEZONE_BYTES)
  ) {
    throw new TypeError("timezone must be a string no longer than 255 bytes");
  }
  const end = endDateInput ?? new Date();
  const start =
    startDateInput ?? new Date(getDateTime(toDate(end)) - 7 * 86_400_000);
  const startDate = formatApiDate(start);
  const endDate = formatApiDate(end);
  if (Date.parse(toIsoDate(startDate)) > Date.parse(toIsoDate(endDate))) {
    throw new RangeError("Sleep data startDate must not be after endDate");
  }
  const timezone = timezoneInput ?? "";
  if (timezone && !isValidTimeZone(timezone)) {
    throw new RangeError("Sleep data timezone must be a valid IANA timezone");
  }
  return { startDate, endDate, timezone };
}

export function formatApiDate(value: Date | string): string {
  if (
    typeof value === "string" &&
    utf8ByteLength(value, MAX_DATE_INPUT_BYTES) > MAX_DATE_INPUT_BYTES
  ) {
    throw new RangeError("Invalid sleep data date");
  }
  const time = getDateTime(toDate(value));
  if (!Number.isFinite(time)) throw new RangeError("Invalid sleep data date");
  return new Date(time).toISOString().slice(0, 19).replace("T", " ");
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) {
    return new Date(getDateTime(value));
  }
  if (typeof value !== "string") return new Date(Number.NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(parseEventTime(`${value} 00:00:00`));
  }
  return new Date(parseEventTime(value));
}

function toIsoDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

function parseResponseBody(text: string): unknown {
  if (!text) return undefined;
  validateJsonTextStructure(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  validateParsedJson(value);
  return value;
}

interface ResponseSnapshot {
  status: number;
  ok: boolean;
  body: ResponseBodySnapshot | null;
  getHeader(name: string): unknown;
  text(): Promise<string>;
}

interface ResponseBodySnapshot {
  getReader?: () => ByteStreamReaderSnapshot;
  cancel?: () => Promise<unknown>;
}

interface ByteStreamReaderSnapshot {
  read(): Promise<unknown>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}

function snapshotResponse(value: unknown): ResponseSnapshot | undefined {
  if (!isObject(value)) return undefined;
  try {
    const status = value.status;
    const ok = value.ok;
    const headers = value.headers;
    const body = value.body;
    const text = value.text;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      ok !== (status >= 200 && status <= 299) ||
      !isObject(headers) ||
      typeof text !== "function" ||
      (body !== null && body !== undefined && !isObject(body))
    ) {
      return undefined;
    }
    const getHeader = headers.get;
    if (typeof getHeader !== "function") return undefined;
    const bodySnapshot = snapshotResponseBody(body);
    if (body !== null && body !== undefined && !bodySnapshot) return undefined;
    return {
      status,
      ok,
      body: bodySnapshot,
      getHeader: (name: string): unknown => {
        const result: unknown = Reflect.apply(getHeader, headers, [name]);
        return result;
      },
      text: () => Reflect.apply(text, value, []) as Promise<string>,
    };
  } catch {
    return undefined;
  }
}

function snapshotResponseBody(value: unknown): ResponseBodySnapshot | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return null;
  const getReader = value.getReader;
  const cancel = value.cancel;
  if (getReader !== undefined && typeof getReader !== "function") {
    return null;
  }
  if (cancel !== undefined && typeof cancel !== "function") return null;
  return {
    ...(typeof getReader === "function"
      ? {
          getReader: (): ByteStreamReaderSnapshot =>
            snapshotByteStreamReader(Reflect.apply(getReader, value, [])),
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

function snapshotByteStreamReader(value: unknown): ByteStreamReaderSnapshot {
  if (!isObject(value)) {
    throw new TypeError(
      "Cradlewise API response returned an invalid stream reader",
    );
  }
  const read = value.read;
  const cancel = value.cancel;
  const releaseLock = value.releaseLock;
  if (
    typeof read !== "function" ||
    typeof cancel !== "function" ||
    typeof releaseLock !== "function"
  ) {
    throw new TypeError(
      "Cradlewise API response returned an invalid stream reader",
    );
  }
  return {
    read: () => Promise.resolve(Reflect.apply(read, value, [])),
    cancel: () => Promise.resolve(Reflect.apply(cancel, value, [])),
    releaseLock: () => {
      Reflect.apply(releaseLock, value, []);
    },
  };
}

function snapshotByteStreamChunk(
  value: unknown,
): { done: true } | { done: false; value: Uint8Array } {
  if (!isObject(value)) {
    throw new TypeError(
      "Cradlewise API response returned an invalid stream chunk",
    );
  }
  const done = value.done;
  const chunk = value.value;
  const bytes = done === false ? snapshotUint8Array(chunk) : undefined;
  if (typeof done !== "boolean" || (!done && !bytes)) {
    throw new TypeError(
      "Cradlewise API response returned an invalid stream chunk",
    );
  }
  return done ? { done: true } : { done: false, value: bytes as Uint8Array };
}

function readResponseHeader(
  response: ResponseSnapshot,
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

function validateJsonTextStructure(text: string): void {
  const firstCharacter = text.trimStart()[0];
  if (firstCharacter !== "{" && firstCharacter !== "[") return;
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
      if (depth > MAX_JSON_DEPTH) {
        throw new TypeError("JSON response exceeds the maximum nesting depth");
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === ",") {
      separators += 1;
      if (separators >= MAX_JSON_NODES) {
        throw new TypeError("JSON response contains too many values");
      }
    }
  }
}

function validateParsedJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new TypeError("JSON response contains too many values");
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new TypeError("JSON response exceeds the maximum nesting depth");
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new TypeError("JSON response contains a non-finite number");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isObject(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function readOnlineState(value: JsonObject): boolean | undefined {
  if (typeof value.online === "boolean") return value.online;
  if (typeof value.state_message !== "string") return undefined;
  try {
    if (
      utf8ByteLength(value.state_message, MAX_EMBEDDED_JSON_BYTES) >
      MAX_EMBEDDED_JSON_BYTES
    ) {
      return undefined;
    }
    validateJsonTextStructure(value.state_message);
    const message: unknown = JSON.parse(value.state_message);
    validateParsedJson(message);
    if (!isObject(message) || !isObject(message.state)) return undefined;
    const state = message.state.state;
    return typeof state === "number" && Number.isInteger(state)
      ? state === 1
      : undefined;
  } catch {
    return undefined;
  }
}

async function readResponseText(
  response: ResponseSnapshot,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = readContentLength(
    readResponseHeader(response, "content-length"),
  );
  if (contentLength !== undefined && contentLength > maximumBytes) {
    cancelResponseSnapshot(response);
    throw new RangeError("Cradlewise API response exceeds the size limit");
  }
  if (!response.body?.getReader) {
    const text = await raceWithAbort(response.text(), signal, () => {
      cancelResponseSnapshot(response);
    });
    if (typeof text !== "string") {
      throw new TypeError("Cradlewise API response text must be a string");
    }
    if (utf8ByteLength(text, maximumBytes) > maximumBytes) {
      throw new RangeError("Cradlewise API response exceeds the size limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  const textChunks: string[] = [];
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
      const chunk = snapshotByteStreamChunk(
        await raceWithAbort(reader.read(), signal, () => {
          void cancelReader();
        }),
      );
      if (chunk.done) break;
      const { value } = chunk;
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) {
        cancelReader();
        throw new RangeError("Cradlewise API response has too many chunks");
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelReader();
        throw new RangeError("Cradlewise API response exceeds the size limit");
      }
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    return textChunks.join("");
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
}

function readContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("Response content-length header is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Response content-length header is invalid");
  }
  return parsed;
}

function cancelResponseSnapshot(response: ResponseSnapshot): void {
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

function cancelResponseBody(response: { body?: unknown }): void {
  try {
    const body = response.body;
    if (!isObject(body)) return;
    const cancel: unknown = body.cancel;
    if (typeof cancel !== "function") return;
    const cancellation: unknown = Reflect.apply(cancel, body, []);
    if (isObject(cancellation) && typeof cancellation.then === "function") {
      void Promise.resolve(cancellation).catch(() => undefined);
    }
  } catch {
    return;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnAny(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => Object.hasOwn(value, key));
}

function isPlainObject<T extends object>(
  value: T,
): value is T & Record<string, unknown>;
function isPlainObject(value: unknown): value is Record<string, unknown>;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readClientAuthSnapshot(value: unknown):
  | {
      email: string;
      apiBaseUrl: string;
      cognitoRegion: string;
      ensureValid: () => Promise<unknown>;
      authenticate: () => Promise<unknown>;
    }
  | undefined {
  if (!isObject(value)) return undefined;
  try {
    const email = value.email;
    const ensureValid = value.ensureValid;
    const authenticate = value.authenticate;
    const appConfig = value.appConfig;
    if (!isObject(appConfig)) return undefined;
    const apiBaseUrl = appConfig.apiBaseUrl;
    const cognitoRegion = appConfig.cognitoRegion;
    if (
      typeof email !== "string" ||
      email.length === 0 ||
      utf8ByteLength(email, 320) > 320 ||
      email !== email.trim() ||
      hasControlCharacter(email) ||
      typeof ensureValid !== "function" ||
      typeof authenticate !== "function" ||
      typeof apiBaseUrl !== "string" ||
      typeof cognitoRegion !== "string" ||
      !isApiBaseUrlForRegion(apiBaseUrl, cognitoRegion)
    ) {
      return undefined;
    }
    return {
      email,
      apiBaseUrl,
      cognitoRegion,
      ensureValid: () => {
        const result: unknown = Reflect.apply(ensureValid, value, []);
        return Promise.resolve(result);
      },
      authenticate: () => {
        const result: unknown = Reflect.apply(authenticate, value, []);
        return Promise.resolve(result);
      },
    };
  } catch {
    return undefined;
  }
}

function readSigningCredentials(
  value: unknown,
): CradlewiseAwsCredentials | undefined {
  if (!isObject(value)) return undefined;
  try {
    const aws = value.aws;
    if (!isObject(aws)) return undefined;
    const accessKeyId = aws.accessKeyId;
    const secretAccessKey = aws.secretAccessKey;
    const sessionToken = aws.sessionToken;
    const expiration = aws.expiration;
    const expirationTime =
      expiration instanceof Date ? getDateTime(expiration) : Number.NaN;
    if (
      !isCredentialValue(accessKeyId) ||
      !isCredentialValue(secretAccessKey) ||
      !isCredentialValue(sessionToken) ||
      !(expiration instanceof Date) ||
      !Number.isFinite(expirationTime) ||
      expirationTime <= Date.now()
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

function isCredentialValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value, MAX_CREDENTIAL_BYTES) <= MAX_CREDENTIAL_BYTES &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isSafeDisplayString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8ByteLength(value, MAX_DISPLAY_STRING_BYTES) <=
      MAX_DISPLAY_STRING_BYTES &&
    !hasControlCharacter(value)
  );
}

function isInboxMessagesResponse(
  value: unknown,
): value is InboxMessagesResponse {
  if (!isPlainObject(value)) return false;
  if (!hasOwnAny(value, ["baby_notifications", "cradlewise_notifications"])) {
    return false;
  }
  return [value.baby_notifications, value.cradlewise_notifications].every(
    (messages) =>
      messages === undefined ||
      messages === null ||
      (Array.isArray(messages) &&
        messages.length <= MAX_INBOX_RECORDS &&
        messages.every(isInboxMessage)),
  );
}

function isUserDevicesResponse(value: unknown): value is UserDevicesResponse {
  if (!isPlainObject(value) || !Array.isArray(value.user_devices)) return false;
  const users: unknown[] = value.user_devices;
  if (
    users.length > MAX_USER_DEVICE_RECORDS ||
    (value.no_of_devices !== undefined &&
      value.no_of_devices !== null &&
      (typeof value.no_of_devices !== "number" ||
        !Number.isSafeInteger(value.no_of_devices) ||
        value.no_of_devices < -1))
  ) {
    return false;
  }
  let deviceCount = 0;
  for (const user of users) {
    if (!isPlainObject(user)) return false;
    const emailId = user.email_id;
    const devicesValue = user.devices;
    if (
      (emailId !== undefined &&
        emailId !== null &&
        !isSafeDisplayString(emailId)) ||
      (devicesValue !== undefined &&
        devicesValue !== null &&
        !Array.isArray(devicesValue))
    ) {
      return false;
    }
    const devices: unknown[] = Array.isArray(devicesValue) ? devicesValue : [];
    for (const device of devices) {
      deviceCount += 1;
      if (!isPlainObject(device)) return false;
      const deviceId = device.device_id;
      const lastConnectedTime = device.last_connected_time;
      if (
        deviceCount > MAX_USER_DEVICE_RECORDS ||
        (deviceId !== undefined &&
          deviceId !== null &&
          !isSafeDisplayString(deviceId)) ||
        (lastConnectedTime !== undefined &&
          lastConnectedTime !== null &&
          (typeof lastConnectedTime !== "number" ||
            !Number.isFinite(lastConnectedTime) ||
            !Number.isSafeInteger(lastConnectedTime)))
      ) {
        return false;
      }
    }
  }
  return true;
}

function isInvalidInboxDeviceError(
  error: unknown,
): error is CradlewiseApiError {
  if (!(error instanceof CradlewiseApiError) || error.status !== 400) {
    return false;
  }
  const body = error.responseBody;
  return (
    isPlainObject(body) &&
    body.errorType === "API_FAILED" &&
    body.message === "device_id is invalid."
  );
}

function isInboxMessage(value: unknown): value is InboxMessage {
  if (!isPlainObject(value)) return false;
  const numberFields = [value.message_id];
  const stringFields = [
    value.message_time,
    value.message_type,
    value.title,
    value.body,
    value.content_url,
    value.thumbnail_url,
    value.presentation_image_url,
    value.content_type,
  ];
  return (
    numberFields.every(
      (field) =>
        field === undefined ||
        field === null ||
        (typeof field === "number" && Number.isSafeInteger(field)),
    ) &&
    stringFields.every(
      (field) =>
        field === undefined || field === null || isSafeDisplayString(field),
    )
  );
}

function inboxImageUrl(message: InboxMessage): string | undefined {
  const candidates = [
    message.presentation_image_url,
    message.thumbnail_url,
    message.content_type === "image" ? message.content_url : undefined,
  ];
  return candidates.find(isHttpsUrl);
}

function cribPhotoFromMessage(message: InboxMessage, url: string): CradlePhoto {
  return {
    url,
    ...(typeof message.message_id === "number"
      ? { messageId: message.message_id }
      : {}),
    ...(typeof message.message_time === "string"
      ? { messageTime: message.message_time }
      : {}),
    ...(typeof message.title === "string" ? { title: message.title } : {}),
    ...(typeof message.content_type === "string"
      ? { contentType: message.content_type }
      : {}),
  };
}

function isHttpsUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value, MAX_QUERY_PARAMETER_BYTES) > MAX_QUERY_PARAMETER_BYTES
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function hasInvalidHeaderCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) return true;
  }
  return false;
}

function hasPathDotSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => {
    const normalized = segment.replaceAll(/%2e/gi, ".");
    return normalized === "." || normalized === "..";
  });
}

function unexpectedResponse(endpoint: string, responseBody: unknown): Error {
  return new CradlewiseApiError(
    `Cradlewise API ${endpoint} returned an unexpected response`,
    { responseBody },
  );
}

function requireQueryValue(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value, MAX_QUERY_VALUE_BYTES) > MAX_QUERY_VALUE_BYTES ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new RangeError(
      `${field} must be a nonempty control-free string without surrounding whitespace`,
    );
  }
  return value;
}

function isIdentifier(value: unknown): value is string | number {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      utf8ByteLength(value, 256) <= 256 &&
      value === value.trim() &&
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("%") &&
      !value.includes("?") &&
      !value.includes("#") &&
      !hasControlCharacter(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function encodePathIdentifier(value: unknown, field: string): string {
  if (!isIdentifier(value)) {
    throw new RangeError(`${field} must be a nonempty identifier`);
  }
  return encodeURIComponent(value);
}

function requireCradle(value: unknown): asserts value is Cradle {
  if (!(value instanceof Cradle)) {
    throw new TypeError("cradle must be a Cradle instance");
  }
}

function isSleepEvent(value: unknown): value is SleepEvent {
  if (!isObject(value)) return false;
  return (
    (value.event_time === undefined ||
      value.event_time === null ||
      (typeof value.event_time === "string" &&
        utf8ByteLength(value.event_time, MAX_DATE_INPUT_BYTES) <=
          MAX_DATE_INPUT_BYTES &&
        Number.isFinite(parseEventTime(value.event_time)))) &&
    (value.event_value === undefined ||
      value.event_value === null ||
      (typeof value.event_value === "string" &&
        utf8ByteLength(value.event_value, MAX_QUERY_VALUE_BYTES) <=
          MAX_QUERY_VALUE_BYTES &&
        !hasControlCharacter(value.event_value)) ||
      (typeof value.event_value === "number" &&
        Number.isSafeInteger(value.event_value))) &&
    isOptionalNonnegativeIntegerLike(value.soothe_count)
  );
}

function isSleepEventArray(value: unknown): value is SleepEvent[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SLEEP_RECORDS &&
    (value as unknown[]).every(isSleepEvent)
  );
}

function isSleepAnalyticsResponse(
  value: unknown,
): value is SleepAnalyticsResponse {
  if (!isObject(value)) return false;
  return (
    [
      "total_sleep",
      "total_awake",
      "soothe_count",
      "sleep_sessions",
      "awake_sessions",
      "successful_bounce_count",
      "auto_soothe_events",
      "auto_soothe_counts",
      "timezone",
    ].some((key) => Object.hasOwn(value, key)) &&
    isOptionalNonnegativeIntegerLike(value.total_sleep) &&
    isOptionalNonnegativeIntegerLike(value.total_awake) &&
    isOptionalNonnegativeIntegerLike(value.soothe_count) &&
    isOptionalMetricArray(value.sleep_sessions, true) &&
    isOptionalMetricArray(value.awake_sessions, true) &&
    isOptionalMetricArray(value.successful_bounce_count, false) &&
    (value.auto_soothe_events === undefined ||
      value.auto_soothe_events === null ||
      (Array.isArray(value.auto_soothe_events) &&
        value.auto_soothe_events.length <= MAX_SLEEP_RECORDS &&
        value.auto_soothe_events.every(isSafeDisplayString))) &&
    (value.auto_soothe_counts === undefined ||
      value.auto_soothe_counts === null ||
      isNonnegativeInteger(value.auto_soothe_counts)) &&
    (value.timezone === undefined ||
      value.timezone === null ||
      (typeof value.timezone === "string" && isValidTimeZone(value.timezone)))
  );
}

function isOptionalNonnegativeIntegerLike(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return isNonnegativeInteger(value);
  if (typeof value !== "string") return false;
  if (utf8ByteLength(value, 64) > 64) return false;
  const normalized = value.trim();
  if (!/^\+?\d+$/.test(normalized)) return false;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function isOptionalMetricArray(value: unknown, multiValue: boolean): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) &&
      value.length <= MAX_SLEEP_RECORDS &&
      value.every(
        (entry) =>
          isObject(entry) &&
          (entry.date === undefined ||
            entry.date === null ||
            (typeof entry.date === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
              Number.isFinite(parseEventTime(`${entry.date} 00:00:00`)))) &&
          (entry.value === undefined ||
            entry.value === null ||
            (multiValue
              ? Array.isArray(entry.value) &&
                entry.value.every(isNonnegativeInteger)
              : isNonnegativeInteger(entry.value))),
      ))
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidTimeZone(value: string): boolean {
  if (
    utf8ByteLength(value, MAX_TIMEZONE_BYTES) > MAX_TIMEZONE_BYTES ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
