import { SLEEP_PHASE_NAMES } from "./constants.js";
import { getDateTime } from "./date-utils.js";
import { SleepAnalytics } from "./models.js";
import { utf8ByteLength } from "./text-utils.js";
import type { JsonObject, SleepEvent } from "./types.js";

const MAX_ANALYTICS_RECORDS = 100_000;
const MAX_EVENT_TIME_BYTES = 64;
const MAX_TIMEZONE_BYTES = 255;

export function aggregateSleepAnalytics(
  events: SleepEvent[],
  serverAnalytics?: JsonObject,
  now = new Date(),
  _timezone?: string,
  sleepSessionsSaved?: string[],
  rangeStart?: Date,
): SleepAnalytics {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  if (events.length > MAX_ANALYTICS_RECORDS) {
    throw new RangeError("events must contain at most 100000 items");
  }
  if (!(now instanceof Date)) {
    throw new TypeError("now must be a Date");
  }
  if (rangeStart !== undefined && !(rangeStart instanceof Date)) {
    throw new TypeError("rangeStart must be a Date");
  }
  if (serverAnalytics !== undefined && !isPlainObject(serverAnalytics)) {
    throw new TypeError("serverAnalytics must be an object");
  }
  if (
    sleepSessionsSaved !== undefined &&
    (!Array.isArray(sleepSessionsSaved) ||
      sleepSessionsSaved.length > MAX_ANALYTICS_RECORDS)
  ) {
    throw new TypeError("sleepSessionsSaved must be an array of strings");
  }
  const savedSessions =
    sleepSessionsSaved === undefined
      ? undefined
      : copySavedSessions(sleepSessionsSaved);
  const nowTime = getDateTime(now);
  if (!Number.isFinite(nowTime)) {
    throw new RangeError("now must be a valid date");
  }
  const rangeStartTime =
    rangeStart === undefined
      ? Number.NEGATIVE_INFINITY
      : getDateTime(rangeStart);
  if (!Number.isFinite(rangeStartTime) && rangeStart !== undefined) {
    throw new RangeError("rangeStart must be a valid date");
  }
  if (rangeStartTime > nowTime) {
    throw new RangeError("rangeStart must not be after now");
  }
  const analytics = new SleepAnalytics({ events });
  const sourceEvents = analytics.events;
  const naps: Array<{
    start: string;
    startTime: number;
    end?: string;
    endTime?: number;
  }> = [];
  let currentNapStart: { value: string; time: number } | undefined;
  let sleepMilliseconds = 0;
  let awakeMilliseconds = 0;

  if (savedSessions) {
    analytics.totalSootheCount = savedSessions.filter((value) => {
      const time = parseEventTime(value);
      return Number.isFinite(time) && time >= rangeStartTime && time <= nowTime;
    }).length;
  }

  const sourceTemporalEvents = sourceEvents
    .flatMap((event) => {
      if (typeof event.event_time !== "string") return [];
      const time = parseEventTime(event.event_time);
      return Number.isFinite(time)
        ? [
            {
              event: event as SleepEvent & { event_time: string },
              time,
            },
          ]
        : [];
    })
    .filter(({ time }) => time <= nowTime)
    .sort((left, right) => left.time - right.time);

  if (!savedSessions) {
    for (const { event, time } of sourceTemporalEvents) {
      if (time < rangeStartTime) continue;
      if (sleepPhaseName(event.event_value) === "sleep") {
        const sootheCount = nonnegativeInteger(event.soothe_count) ?? 0;
        if (!Number.isSafeInteger(analytics.totalSootheCount + sootheCount)) {
          throw new RangeError("total soothe count exceeds a safe integer");
        }
        analytics.totalSootheCount += sootheCount;
      }
    }
  }

  let temporalEvents = sourceTemporalEvents.filter(
    ({ time }) => time >= rangeStartTime,
  );
  if (rangeStart !== undefined) {
    let priorEvent: (typeof sourceTemporalEvents)[number] | undefined;
    for (const candidate of sourceTemporalEvents) {
      if (candidate.time >= rangeStartTime) break;
      priorEvent = candidate;
    }
    if (priorEvent) {
      temporalEvents = [
        {
          event: {
            ...priorEvent.event,
            event_time: new Date(rangeStartTime).toISOString(),
          },
          time: rangeStartTime,
        },
        ...temporalEvents,
      ];
    }
  }

  for (const [index, { event, time }] of temporalEvents.entries()) {
    const phase = sleepPhaseName(event.event_value);
    if (phase === "sleep" && !currentNapStart) {
      currentNapStart = { value: event.event_time, time };
    } else if (phase !== "sleep" && currentNapStart) {
      naps.push({
        start: currentNapStart.value,
        startTime: currentNapStart.time,
        end: event.event_time,
        endTime: time,
      });
      currentNapStart = undefined;
    }

    const intervalEnd = temporalEvents[index + 1]?.time ?? nowTime;
    if (Number.isFinite(intervalEnd) && intervalEnd >= time) {
      const duration = intervalEnd - time;
      if (phase === "sleep") sleepMilliseconds += duration;
      if (isCountedAwakeState(event.event_value)) {
        awakeMilliseconds += duration;
      }
    }
  }

  if (currentNapStart) {
    naps.push({
      start: currentNapStart.value,
      startTime: currentNapStart.time,
    });
  }
  analytics.napCount = naps.length;
  analytics.totalSleepMinutes = safeElapsedMinutes(
    sleepMilliseconds,
    "total sleep",
  );
  analytics.totalAwakeMinutes = safeElapsedMinutes(
    awakeMilliseconds,
    "total awake",
  );
  for (const nap of naps) {
    const start = nap.startTime;
    const end = nap.endTime ?? nowTime;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      continue;
    const duration = safeElapsedMinutes(end - start, "nap duration");
    analytics.longestNapMinutes = Math.max(
      analytics.longestNapMinutes,
      duration,
    );
  }

  const lastNap = naps.at(-1);
  analytics.lastNapStart = lastNap?.start;
  analytics.lastNapEnd = lastNap?.end;

  const lastEvent = sourceTemporalEvents.at(-1)?.event;
  analytics.lastEventTime =
    typeof lastEvent?.event_time === "string"
      ? lastEvent.event_time
      : undefined;
  analytics.lastEventValue = sleepPhaseName(lastEvent?.event_value);

  if (serverAnalytics) {
    const totalSleep = serverAnalytics.total_sleep;
    const sleepSessions = serverAnalytics.sleep_sessions;
    const totalAwake = serverAnalytics.total_awake;
    const awakeSessions = serverAnalytics.awake_sessions;
    const sootheCount = serverAnalytics.soothe_count;
    const autoSootheCounts = serverAnalytics.auto_soothe_counts;
    const autoSootheEvents = serverAnalytics.auto_soothe_events;
    analytics.totalSleepMinutes =
      nonnegativeInteger(totalSleep) ??
      sumMultiValueMetric(sleepSessions) ??
      analytics.totalSleepMinutes;
    analytics.totalAwakeMinutes =
      nonnegativeInteger(totalAwake) ??
      sumMultiValueMetric(awakeSessions) ??
      analytics.totalAwakeMinutes;
    analytics.totalSootheCount =
      nonnegativeInteger(sootheCount) ??
      nonnegativeInteger(autoSootheCounts) ??
      countStringArray(autoSootheEvents) ??
      analytics.totalSootheCount;
  }
  return analytics;
}

function copySavedSessions(value: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("sleepSessionsSaved must be an array of strings");
    }
    const entry: unknown = value[index];
    if (
      typeof entry !== "string" ||
      utf8ByteLength(entry, MAX_EVENT_TIME_BYTES) > MAX_EVENT_TIME_BYTES
    ) {
      throw new TypeError("sleepSessionsSaved must be an array of strings");
    }
    result.push(entry);
  }
  return result;
}

function safeElapsedMinutes(milliseconds: number, description: string): number {
  const minutes = Math.round(milliseconds / 60_000);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`${description} exceeds a safe integer`);
  }
  return minutes;
}

function sumMultiValueMetric(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length > MAX_ANALYTICS_RECORDS) {
    return undefined;
  }
  let total = 0;
  let hasMetric = value.length === 0;
  let processedValues = 0;
  for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
    if (!Object.hasOwn(value, entryIndex)) return undefined;
    const entry: unknown = value[entryIndex];
    if (typeof entry !== "object" || entry === null) continue;
    const values: unknown = Reflect.get(entry, "value");
    if (!Array.isArray(values)) continue;
    processedValues += values.length;
    if (processedValues > MAX_ANALYTICS_RECORDS) return undefined;
    if (values.length === 0) hasMetric = true;
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (!Object.hasOwn(values, valueIndex)) return undefined;
      const item: unknown = values[valueIndex];
      const parsed = nonnegativeInteger(item);
      if (parsed === undefined) continue;
      hasMetric = true;
      if (!Number.isSafeInteger(total + parsed)) return undefined;
      total += parsed;
    }
  }
  return hasMetric ? total : undefined;
}

function countStringArray(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length > MAX_ANALYTICS_RECORDS) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") {
      return undefined;
    }
  }
  return value.length;
}

export function sleepPhaseName(value: unknown): string | undefined {
  const parsed = integer(value);
  if (parsed === undefined) {
    return typeof value === "string" || typeof value === "boolean"
      ? String(value)
      : undefined;
  }
  return (
    SLEEP_PHASE_NAMES[parsed as keyof typeof SLEEP_PHASE_NAMES] ??
    String(parsed)
  );
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  if (utf8ByteLength(value, 64) > 64) return undefined;
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function isCountedAwakeState(value: unknown): boolean {
  return integer(value) === 1 || value === "awake";
}

export function parseEventTime(value: string, timezone?: string): number {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value, MAX_EVENT_TIME_BYTES) > MAX_EVENT_TIME_BYTES ||
    (timezone !== undefined &&
      (typeof timezone !== "string" ||
        timezone.length === 0 ||
        timezone !== timezone.trim() ||
        utf8ByteLength(timezone, MAX_TIMEZONE_BYTES) > MAX_TIMEZONE_BYTES ||
        hasControlCharacter(timezone)))
  ) {
    return NaN;
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!match) return NaN;
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  const second = match[6];
  if (!year || !month || !day || !hour || !minute || !second) return NaN;
  const fraction = match[7] ?? "";
  const zone = match[8];
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const localDate = new Date(0);
  localDate.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber);
  localDate.setUTCHours(hourNumber, minuteNumber, secondNumber, 0);
  if (
    localDate.getUTCFullYear() !== yearNumber ||
    localDate.getUTCMonth() !== monthNumber - 1 ||
    localDate.getUTCDate() !== dayNumber ||
    localDate.getUTCHours() !== hourNumber ||
    localDate.getUTCMinutes() !== minuteNumber ||
    localDate.getUTCSeconds() !== secondNumber
  ) {
    return NaN;
  }
  const localTime = getDateTime(localDate);
  const milliseconds = fractionMilliseconds(fraction);
  if (zone === "Z") return localTime + milliseconds;
  if (zone) {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return NaN;
    const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
    return localTime + milliseconds + (zone.startsWith("+") ? -offset : offset);
  }
  if (!timezone) return localTime + milliseconds;

  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    let candidate = localTime;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const represented = formattedTimeAsUtc(formatter, candidate);
      const adjustment = localTime - represented;
      if (adjustment === 0) break;
      candidate += adjustment;
    }
    if (formattedTimeAsUtc(formatter, candidate) !== localTime) return NaN;
    return candidate + milliseconds;
  } catch {
    return NaN;
  }
}

function formattedTimeAsUtc(
  formatter: Intl.DateTimeFormat,
  value: number,
): number {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const { year, month, day, hour, minute, second } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return NaN;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function fractionMilliseconds(value: string): number {
  return Number(`${value}000`.slice(0, 3));
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}
