import { SLEEP_PHASE_NAMES } from "./constants.js";
import { utf8ByteLength } from "./text-utils.js";
import type {
  CradleState,
  CradleStatusSource,
  SleepAnalyticsData,
  SleepAnalyticsSource,
  SleepEvent,
} from "./types.js";

const MAX_STATE_DEPTH = 100;
const MAX_STATE_NODES = 100_000;
const MAX_STATE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_ANALYTICS_EVENTS = 100_000;
const MAX_ANALYTICS_EVENT_NODES = 1_000_000;
const MAX_ANALYTICS_EVENT_TEXT_BYTES = 16 * 1024 * 1024;

interface CloneBudget {
  count: number;
  maximumNodes: number;
  textBytes: number;
  maximumTextBytes: number;
  subject: string;
}

export interface CradleOptions {
  cradleId: string;
  babyId?: string;
  babyName?: string;
  firmwareVersion?: string;
  timezone?: string;
  serialNumber?: string;
  state?: CradleState;
  online?: boolean;
  statusPartial?: boolean;
  unavailableStatusSources?: CradleStatusSource[];
}

export interface CradleData {
  cradleId: string;
  babyId?: string;
  babyName?: string;
  firmwareVersion?: string;
  timezone?: string;
  serialNumber?: string;
  state: CradleState;
  online: boolean;
  sleepPhaseName?: string;
  statusPartial: boolean;
  unavailableStatusSources: CradleStatusSource[];
}

export function cloneCradleState(state: unknown): CradleState {
  if (!isPlainObject(state)) {
    throw new TypeError("state must be a plain object");
  }
  return cloneSafeValue(state) as CradleState;
}

export class Cradle {
  readonly cradleId: string;
  babyId: string | undefined;
  babyName: string | undefined;
  firmwareVersion: string | undefined;
  timezone: string | undefined;
  serialNumber: string | undefined;
  #state: CradleState;
  online: boolean;
  #unavailableStatusSources: CradleStatusSource[];

  constructor(options: CradleOptions) {
    if (!isPlainObject(options)) {
      throw new TypeError("options must be a plain object");
    }
    const cradleId = options.cradleId;
    const babyId = options.babyId;
    const babyName = options.babyName;
    const firmwareVersion = options.firmwareVersion;
    const timezone = options.timezone;
    const serialNumber = options.serialNumber;
    const state = options.state;
    const online = options.online;
    const requestedStatusPartial = options.statusPartial;
    const requestedUnavailableStatusSources = options.unavailableStatusSources;
    if (
      typeof cradleId !== "string" ||
      cradleId.length === 0 ||
      utf8ByteLength(cradleId, 256) > 256 ||
      cradleId !== cradleId.trim() ||
      cradleId === "." ||
      cradleId === ".." ||
      cradleId.includes("/") ||
      cradleId.includes("\\") ||
      cradleId.includes("%") ||
      cradleId.includes("?") ||
      cradleId.includes("#") ||
      hasControlCharacter(cradleId)
    ) {
      throw new TypeError("cradleId must be a nonempty identifier");
    }
    for (const [field, value] of [
      ["babyName", babyName],
      ["firmwareVersion", firmwareVersion],
      ["timezone", timezone],
      ["serialNumber", serialNumber],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          utf8ByteLength(value, 4096) > 4096 ||
          hasControlCharacter(value))
      ) {
        throw new TypeError(
          `${field} must be a control-free string no longer than 4096 bytes`,
        );
      }
    }
    if (babyId !== undefined && typeof babyId !== "string") {
      throw new TypeError("babyId must be a string");
    }
    if (babyId && !isModelIdentifier(babyId)) {
      throw new TypeError("babyId must be a nonempty identifier");
    }
    if (online !== undefined && typeof online !== "boolean") {
      throw new TypeError("online must be a boolean");
    }
    if (
      requestedStatusPartial !== undefined &&
      typeof requestedStatusPartial !== "boolean"
    ) {
      throw new TypeError("statusPartial must be a boolean");
    }
    const unavailableStatusSources = copyStatusSources(
      requestedUnavailableStatusSources ?? [],
    );
    const statusPartial = unavailableStatusSources.length > 0;
    if (
      requestedStatusPartial !== undefined &&
      requestedStatusPartial !== statusPartial
    ) {
      throw new TypeError(
        "statusPartial must match whether status sources are unavailable",
      );
    }
    this.cradleId = cradleId;
    this.babyId = babyId;
    this.babyName = babyName;
    this.firmwareVersion = firmwareVersion;
    this.timezone = timezone;
    this.serialNumber = serialNumber;
    this.#state = {};
    this.replaceState(state ?? {});
    this.online = online ?? false;
    this.#unavailableStatusSources = unavailableStatusSources;
    Object.defineProperty(this, "cradleId", {
      configurable: false,
      enumerable: true,
      writable: false,
    });
  }

  get state(): CradleState {
    return cloneCradleState(this.#state);
  }

  get statusPartial(): boolean {
    return this.#unavailableStatusSources.length > 0;
  }

  get unavailableStatusSources(): CradleStatusSource[] {
    return [...this.#unavailableStatusSources];
  }

  set unavailableStatusSources(value: CradleStatusSource[]) {
    this.#unavailableStatusSources = copyStatusSources(value);
  }

  get babyPresent(): boolean | undefined {
    return toBoolean(
      readStateField(this.#state, "babyPresent", "baby_present"),
    );
  }
  get babySleepState(): string | undefined {
    return toString(
      readStateField(this.#state, "babySleepState", "baby_sleep_state"),
    );
  }
  get babyNeedsAttention(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "babyNeedsAttention"));
  }
  get babyNeedsHelp(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "babyNeedsHelp"));
  }
  get isCribHelping(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "isCribHelping"));
  }
  get loudSoundDetected(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "loudSoundDetected"));
  }
  get insideSleepSchedule(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "insideSleepSchedule"));
  }
  get insideSoothingWindow(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "insideSoothingWindow"));
  }
  get rockingNotEffective(): boolean | undefined {
    return toBoolean(readStateField(this.#state, "rockingNotEffective"));
  }
  get cradleMode(): string | undefined {
    return toString(
      readStateField(
        this.#state,
        "mode",
        "userSetCradleMode",
        "detectedCradleMode",
      ),
    );
  }
  get bounceMode(): string | number | undefined {
    return toStringOrNumber(readStateField(this.#state, "bounceMode"));
  }
  get bounceSetting(): string | number | undefined {
    return toStringOrNumber(
      readStateField(this.#state, "bounceSetting", "bounce_setting"),
    );
  }
  get responsivitySetting(): string | number | undefined {
    return toStringOrNumber(
      readStateField(
        this.#state,
        "responsivitySetting",
        "responsivity_setting",
      ),
    );
  }
  get musicMode(): string | number | undefined {
    return toStringOrNumber(readStateField(this.#state, "musicMode"));
  }
  get bouncing(): boolean | undefined {
    return toBoolean(readNestedStateField(this.#state, ["actuator", "on"]));
  }
  get bounceAmplitude(): number | undefined {
    return toNumber(
      readNestedStateField(this.#state, ["actuator", "amplitude"]),
    );
  }
  get bounceIntensityLevel(): number | undefined {
    const value = toInteger(readStateField(this.#state, "bounceLevel"));
    return value !== undefined && value >= 0 && value <= 4
      ? value + 1
      : undefined;
  }
  get maxBouncePercent(): number | undefined {
    return toPercent(readStateField(this.#state, "maxBounceLimit"));
  }
  get musicPlaying(): boolean | undefined {
    return toBoolean(
      readNestedStateField(
        this.#state,
        ["music", "play"],
        ["soundSynth", "play"],
      ),
    );
  }
  get musicVolume(): number | undefined {
    return toNumber(
      readNestedStateField(
        this.#state,
        ["music", "volume"],
        ["soundSynth", "volume"],
      ),
    );
  }
  get musicIntensityLevel(): number | undefined {
    const value = toInteger(readStateField(this.#state, "musicLevel"));
    return value !== undefined && value >= 0 && value <= 4
      ? value + 1
      : undefined;
  }
  get maxMusicPercent(): number | undefined {
    return toPercent(readStateField(this.#state, "maxVolumeLimit"));
  }
  get musicMood(): string | undefined {
    return toString(
      readNestedStateField(
        this.#state,
        ["music", "mood"],
        ["soundSynth", "trackName"],
      ),
    );
  }
  get lightOn(): boolean | undefined {
    return toBoolean(readNestedStateField(this.#state, ["light", "lightOn"]));
  }
  get lightIntensity(): number | undefined {
    return toNumber(
      readNestedStateField(this.#state, ["light", "lightIntensity"]),
    );
  }
  get batteryLife(): number | undefined {
    return toNumber(
      readNestedStateField(this.#state, ["deviceStatus", "batteryLife"]),
    );
  }
  get charging(): boolean | undefined {
    return toBoolean(
      readNestedStateField(this.#state, ["deviceStatus", "charging"]),
    );
  }
  get supplyRemoved(): boolean | undefined {
    return toBoolean(
      readNestedStateField(this.#state, ["deviceStatus", "supplyRemoved"]),
    );
  }
  get sleepTime(): string | undefined {
    return toString(readStateField(this.#state, "sleepTime"));
  }
  get wakeUpTime(): string | undefined {
    return toString(readStateField(this.#state, "wakeUpTime"));
  }
  get sleepPhaseRaw(): number | undefined {
    const v2 = readNestedStateField(this.#state, [
      "babySleepPhaseV2",
      "eventValue",
    ]);
    return (
      toInteger(v2) ?? toInteger(readStateField(this.#state, "babySleepPhase"))
    );
  }
  get sleepPhaseName(): string | undefined {
    const raw = this.sleepPhaseRaw;
    if (raw !== undefined)
      return (
        SLEEP_PHASE_NAMES[raw as keyof typeof SLEEP_PHASE_NAMES] ??
        `unknown (${raw})`
      );
    return typeof this.#state.babySleepPhase === "string"
      ? this.#state.babySleepPhase
      : undefined;
  }

  updateState(update: CradleState): void {
    const validated = cloneCradleState(update);
    this.#state = cloneCradleState(deepMerge(this.#state, validated));
  }

  replaceState(state: CradleState): void {
    this.#state = cloneCradleState(state);
  }

  toJSON(): CradleData {
    if (this.babyId !== undefined && typeof this.babyId !== "string") {
      throw new TypeError("babyId must be a string");
    }
    if (this.babyId && !isModelIdentifier(this.babyId)) {
      throw new TypeError("babyId must be a nonempty identifier");
    }
    for (const [field, value] of [
      ["babyName", this.babyName],
      ["firmwareVersion", this.firmwareVersion],
      ["timezone", this.timezone],
      ["serialNumber", this.serialNumber],
    ] as const) {
      validateOptionalDisplayString(value, field);
    }
    if (typeof this.online !== "boolean") {
      throw new TypeError("online must be a boolean");
    }
    return {
      cradleId: this.cradleId,
      online: this.online,
      statusPartial: this.#unavailableStatusSources.length > 0,
      unavailableStatusSources: [...this.#unavailableStatusSources],
      state: cloneCradleState(this.#state),
      ...(this.babyId !== undefined ? { babyId: this.babyId } : {}),
      ...(this.babyName !== undefined ? { babyName: this.babyName } : {}),
      ...(this.firmwareVersion !== undefined
        ? { firmwareVersion: this.firmwareVersion }
        : {}),
      ...(this.timezone !== undefined ? { timezone: this.timezone } : {}),
      ...(this.serialNumber !== undefined
        ? { serialNumber: this.serialNumber }
        : {}),
      ...(this.sleepPhaseName !== undefined
        ? { sleepPhaseName: this.sleepPhaseName }
        : {}),
    };
  }
}

export class SleepAnalytics {
  totalSleepMinutes = 0;
  totalAwakeMinutes = 0;
  totalSootheCount = 0;
  napCount = 0;
  longestNapMinutes = 0;
  lastNapStart: string | undefined;
  lastNapEnd: string | undefined;
  lastEventTime: string | undefined;
  lastEventValue: string | undefined;
  events: SleepEvent[] = [];
  #unavailableSources: SleepAnalyticsSource[];

  constructor(data: Partial<SleepAnalyticsData> = {}) {
    if (!isPlainObject(data)) {
      throw new TypeError("analytics data must be a plain object");
    }
    const totalSleepMinutes = data.totalSleepMinutes;
    const totalAwakeMinutes = data.totalAwakeMinutes;
    const totalSootheCount = data.totalSootheCount;
    const napCount = data.napCount;
    const longestNapMinutes = data.longestNapMinutes;
    const lastNapStart = data.lastNapStart;
    const lastNapEnd = data.lastNapEnd;
    const lastEventTime = data.lastEventTime;
    const lastEventValue = data.lastEventValue;
    const events = data.events;
    const requestedPartial = data.partial;
    const requestedUnavailableSources = data.unavailableSources;
    this.totalSleepMinutes = readNonnegativeInteger(
      totalSleepMinutes,
      "totalSleepMinutes",
    );
    this.totalAwakeMinutes = readNonnegativeInteger(
      totalAwakeMinutes,
      "totalAwakeMinutes",
    );
    this.totalSootheCount = readNonnegativeInteger(
      totalSootheCount,
      "totalSootheCount",
    );
    this.napCount = readNonnegativeInteger(napCount, "napCount");
    this.longestNapMinutes = readNonnegativeInteger(
      longestNapMinutes,
      "longestNapMinutes",
    );
    this.lastNapStart = readOptionalString(lastNapStart, "lastNapStart");
    this.lastNapEnd = readOptionalString(lastNapEnd, "lastNapEnd");
    this.lastEventTime = readOptionalString(lastEventTime, "lastEventTime");
    this.lastEventValue = readOptionalString(lastEventValue, "lastEventValue");
    this.events = copyAnalyticsEvents(events ?? []);
    if (
      requestedPartial !== undefined &&
      typeof requestedPartial !== "boolean"
    ) {
      throw new TypeError("partial must be a boolean");
    }
    const unavailableSources = copyAnalyticsSources(
      requestedUnavailableSources ?? [],
    );
    const partial = unavailableSources.length > 0;
    if (requestedPartial !== undefined && requestedPartial !== partial) {
      throw new TypeError(
        "partial must match whether analytics sources are unavailable",
      );
    }
    this.#unavailableSources = unavailableSources;
  }

  get partial(): boolean {
    return this.#unavailableSources.length > 0;
  }

  get unavailableSources(): SleepAnalyticsSource[] {
    return [...this.#unavailableSources];
  }

  set unavailableSources(value: SleepAnalyticsSource[]) {
    this.#unavailableSources = copyAnalyticsSources(value);
  }

  toJSON(): SleepAnalyticsData {
    const totalSleepMinutes = readNonnegativeInteger(
      this.totalSleepMinutes,
      "totalSleepMinutes",
    );
    const totalAwakeMinutes = readNonnegativeInteger(
      this.totalAwakeMinutes,
      "totalAwakeMinutes",
    );
    const totalSootheCount = readNonnegativeInteger(
      this.totalSootheCount,
      "totalSootheCount",
    );
    const napCount = readNonnegativeInteger(this.napCount, "napCount");
    const longestNapMinutes = readNonnegativeInteger(
      this.longestNapMinutes,
      "longestNapMinutes",
    );
    const lastNapStart = readOptionalString(this.lastNapStart, "lastNapStart");
    const lastNapEnd = readOptionalString(this.lastNapEnd, "lastNapEnd");
    const lastEventTime = readOptionalString(
      this.lastEventTime,
      "lastEventTime",
    );
    const lastEventValue = readOptionalString(
      this.lastEventValue,
      "lastEventValue",
    );
    return {
      totalSleepMinutes,
      totalAwakeMinutes,
      totalSootheCount,
      napCount,
      longestNapMinutes,
      events: copyAnalyticsEvents(this.events),
      partial: this.#unavailableSources.length > 0,
      unavailableSources: [...this.#unavailableSources],
      ...(lastNapStart !== undefined ? { lastNapStart } : {}),
      ...(lastNapEnd !== undefined ? { lastNapEnd } : {}),
      ...(lastEventTime !== undefined ? { lastEventTime } : {}),
      ...(lastEventValue !== undefined ? { lastEventValue } : {}),
    };
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  if (utf8ByteLength(value, 256) > 256) return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function copyStatusSources(value: unknown): CradleStatusSource[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new TypeError(
      "unavailableStatusSources must contain only state, online, or firmware",
    );
  }
  const result: CradleStatusSource[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(
        "unavailableStatusSources must contain only state, online, or firmware",
      );
    }
    const source: unknown = value[index];
    if (source !== "state" && source !== "online" && source !== "firmware") {
      throw new TypeError(
        "unavailableStatusSources must contain only state, online, or firmware",
      );
    }
    result.push(source);
  }
  if (new Set(result).size !== result.length) {
    throw new TypeError("unavailableStatusSources must not contain duplicates");
  }
  return result;
}

function copyAnalyticsSources(value: unknown): SleepAnalyticsSource[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new TypeError(
      "unavailableSources must contain only events or analytics",
    );
  }
  const result: SleepAnalyticsSource[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(
        "unavailableSources must contain only events or analytics",
      );
    }
    const source: unknown = value[index];
    if (source !== "events" && source !== "analytics") {
      throw new TypeError(
        "unavailableSources must contain only events or analytics",
      );
    }
    result.push(source);
  }
  if (new Set(result).size !== result.length) {
    throw new TypeError("unavailableSources must not contain duplicates");
  }
  return result;
}

function copyAnalyticsEvents(value: unknown): SleepEvent[] {
  if (!Array.isArray(value) || value.length > MAX_ANALYTICS_EVENTS) {
    throw new TypeError("events must be an array with at most 100000 items");
  }
  const events: SleepEvent[] = [];
  const budget: CloneBudget = {
    count: 0,
    maximumNodes: MAX_ANALYTICS_EVENT_NODES,
    textBytes: 0,
    maximumTextBytes: MAX_ANALYTICS_EVENT_TEXT_BYTES,
    subject: "events",
  };
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("events must contain plain objects without holes");
    }
    const event: unknown = value[index];
    if (!isPlainObject(event)) {
      throw new TypeError("events must contain plain objects without holes");
    }
    events.push(
      cloneSafeValue(event, new WeakSet<object>(), 0, budget) as SleepEvent,
    );
  }
  return events;
}

function readNonnegativeInteger(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    utf8ByteLength(value, 4096) > 4096 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(
      `${field} must be a control-free string no longer than 4096 bytes`,
    );
  }
  return value;
}

function validateOptionalDisplayString(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      utf8ByteLength(value, 4096) > 4096 ||
      hasControlCharacter(value))
  ) {
    throw new TypeError(
      `${field} must be a control-free string no longer than 4096 bytes`,
    );
  }
}

function toInteger(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function toPercent(value: unknown): number | undefined {
  const parsed = toInteger(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 100
    ? parsed
    : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function stateSources(state: CradleState): Record<string, unknown>[] {
  const rawShadow = state.rawShadow;
  return isPlainObject(rawShadow) ? [state, rawShadow] : [state];
}

function readStateField(state: CradleState, ...keys: string[]): unknown {
  for (const source of stateSources(state)) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function readNestedStateField(
  state: CradleState,
  ...paths: Array<[string, string]>
): unknown {
  for (const source of stateSources(state)) {
    for (const [containerKey, fieldKey] of paths) {
      const container = source[containerKey];
      if (!isPlainObject(container)) continue;
      const value = container[fieldKey];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  update: T,
  depth = 0,
): T {
  if (depth > MAX_STATE_DEPTH) {
    throw new TypeError("state exceeds the maximum nesting depth");
  }
  const result: Record<string, unknown> = { ...target };
  for (const key in update) {
    if (!Object.hasOwn(update, key)) continue;
    if (isUnsafeObjectKey(key)) continue;
    const value: unknown = update[key];
    const previous = result[key];
    result[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value, depth + 1)
        : cloneSafeValue(value, new WeakSet<object>(), depth + 1);
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isModelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
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
    !hasControlCharacter(value)
  );
}

function cloneSafeValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
  budget: CloneBudget = {
    count: 0,
    maximumNodes: MAX_STATE_NODES,
    textBytes: 0,
    maximumTextBytes: MAX_STATE_TEXT_BYTES,
    subject: "state",
  },
): unknown {
  budget.count += 1;
  if (budget.count > budget.maximumNodes) {
    throw new TypeError(`${budget.subject} contains too many values`);
  }
  if (depth > MAX_STATE_DEPTH) {
    throw new TypeError("state exceeds the maximum nesting depth");
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("state values must be valid JSON values");
  }
  if (typeof value === "string") addTextBytes(value, budget);
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) {
      throw new TypeError("state must not contain circular references");
    }
    ancestors.add(value);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        ancestors.delete(value);
        throw new TypeError("state arrays must not contain holes");
      }
      result.push(cloneSafeValue(value[index], ancestors, depth + 1, budget));
    }
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value)) {
    if (typeof value !== "object" || value === null) return value;
    ancestors.delete(value);
    throw new TypeError("state values must use plain JSON objects");
  }
  const result: Record<string, unknown> = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!isUnsafeObjectKey(key)) {
      addTextBytes(key, budget);
      const child: unknown = value[key];
      result[key] = cloneSafeValue(child, ancestors, depth + 1, budget);
    }
  }
  ancestors.delete(value);
  return result;
}

function addTextBytes(value: string, budget: CloneBudget): void {
  budget.textBytes += utf8ByteLength(
    value,
    budget.maximumTextBytes - budget.textBytes,
  );
  if (budget.textBytes > budget.maximumTextBytes) {
    throw new TypeError(`${budget.subject} contains too much string data`);
  }
}
