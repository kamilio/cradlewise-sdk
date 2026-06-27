import { describe, expect, it } from "vitest";
import {
  aggregateSleepAnalytics,
  parseEventTime,
  sleepPhaseName,
} from "../src/analytics.js";

describe("aggregateSleepAnalytics", () => {
  it("calculates naps and merges server metrics", () => {
    const analytics = aggregateSleepAnalytics(
      [
        {
          event_time: "2026-01-01T00:00:00Z",
          event_value: 4,
          soothe_count: "2",
        },
        { event_time: "2026-01-01T00:30:00Z", event_value: 1 },
        { event_time: "2026-01-01T01:00:00Z", event_value: 4 },
        { event_time: "2026-01-01T01:45:00Z", event_value: 0 },
      ],
      { total_sleep: "80", total_awake: 12, soothe_count: 5 },
      new Date("2026-01-01T02:00:00Z"),
    );

    expect(analytics.napCount).toBe(2);
    expect(analytics.longestNapMinutes).toBe(45);
    expect(analytics.totalSleepMinutes).toBe(80);
    expect(analytics.totalAwakeMinutes).toBe(12);
    expect(analytics.totalSootheCount).toBe(5);
    expect(analytics.lastNapStart).toBe("2026-01-01T01:00:00Z");
    expect(analytics.lastNapEnd).toBe("2026-01-01T01:45:00Z");
    expect(analytics.lastEventValue).toBe("away");
  });

  it("snapshots event, session, and server metric accessors once", () => {
    const reads = new Map<string, number>();
    const readOnce = <T>(key: string, value: T, later: T = value) => ({
      enumerable: true,
      get: () => {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? value : later;
      },
    });
    const event = {};
    Object.defineProperties(event, {
      event_time: readOnce("event_time", "2026-01-01T00:00:00Z"),
      event_value: readOnce("event_value", 4, 1),
      soothe_count: readOnce("soothe_count", 2, 99),
    });
    const sessions: string[] = [];
    Object.defineProperty(sessions, 0, {
      configurable: true,
      enumerable: true,
      get: readOnce("saved_session", "2026-01-01T00:05:00Z", "invalid").get,
    });
    sessions.length = 1;
    const server = {};
    Object.defineProperties(server, {
      total_sleep: readOnce("total_sleep", 20, 999),
      total_awake: readOnce("total_awake", 5, 999),
      soothe_count: readOnce("server_soothe_count", undefined),
      auto_soothe_counts: readOnce("auto_soothe_counts", undefined),
      auto_soothe_events: readOnce("auto_soothe_events", ["one"], []),
      sleep_sessions: readOnce("sleep_sessions", undefined),
      awake_sessions: readOnce("awake_sessions", undefined),
    });

    const analytics = aggregateSleepAnalytics(
      [event] as never,
      server,
      new Date("2026-01-01T00:10:00Z"),
      undefined,
      sessions,
    );

    expect(analytics.totalSleepMinutes).toBe(20);
    expect(analytics.totalAwakeMinutes).toBe(5);
    expect(analytics.totalSootheCount).toBe(1);
    expect(Object.fromEntries(reads)).toEqual({
      saved_session: 1,
      event_time: 1,
      event_value: 1,
      soothe_count: 1,
      total_sleep: 1,
      sleep_sessions: 1,
      total_awake: 1,
      awake_sessions: 1,
      server_soothe_count: 1,
      auto_soothe_counts: 1,
      auto_soothe_events: 1,
    });
  });

  it("closes an active nap at the supplied current time", () => {
    const analytics = aggregateSleepAnalytics(
      [{ event_time: "2026-01-01T00:00:00Z", event_value: "4" }],
      undefined,
      new Date("2026-01-01T00:20:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(20);
    expect(analytics.lastNapEnd).toBeUndefined();
  });

  it("does not aggregate events beyond the supplied range end", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:00:00Z", event_value: 4 },
        { event_time: "2026-01-01T02:00:00Z", event_value: 1 },
      ],
      undefined,
      new Date("2026-01-01T01:00:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(60);
    expect(analytics.totalAwakeMinutes).toBe(0);
    expect(analytics.lastEventTime).toBe("2026-01-01T00:00:00Z");
  });

  it("clips intervals and soothe evidence to a supplied range start", () => {
    const analytics = aggregateSleepAnalytics(
      [
        {
          event_time: "2026-01-01T00:00:00Z",
          event_value: 4,
          soothe_count: 9,
        },
        { event_time: "2026-01-01T02:00:00Z", event_value: 1 },
      ],
      undefined,
      new Date("2026-01-01T03:00:00Z"),
      undefined,
      ["2026-01-01T00:30:00Z", "2026-01-01T01:30:00Z"],
      new Date("2026-01-01T01:00:00Z"),
    );

    expect(analytics.totalSleepMinutes).toBe(60);
    expect(analytics.totalAwakeMinutes).toBe(60);
    expect(analytics.totalSootheCount).toBe(1);
    expect(analytics.lastNapStart).toBe("2026-01-01T01:00:00.000Z");
    expect(analytics.lastNapEnd).toBe("2026-01-01T02:00:00Z");
  });

  it("rejects an invalid aggregation boundary", () => {
    expect(() => aggregateSleepAnalytics(null as never)).toThrow(
      "events must be an array",
    );
    expect(() => aggregateSleepAnalytics([], [] as never)).toThrow(
      "serverAnalytics must be an object",
    );
    expect(() => aggregateSleepAnalytics([], undefined, 1 as never)).toThrow(
      "now must be a Date",
    );
    expect(() =>
      aggregateSleepAnalytics([], undefined, new Date(), undefined, [
        1,
      ] as never),
    ).toThrow("array of strings");
    expect(() => aggregateSleepAnalytics([], undefined, new Date(NaN))).toThrow(
      RangeError,
    );
    expect(() =>
      aggregateSleepAnalytics(
        [],
        undefined,
        new Date(),
        undefined,
        undefined,
        1 as never,
      ),
    ).toThrow("rangeStart must be a Date");
    expect(() =>
      aggregateSleepAnalytics(
        [],
        undefined,
        new Date("2026-01-01T00:00:00Z"),
        undefined,
        undefined,
        new Date("2026-01-02T00:00:00Z"),
      ),
    ).toThrow("rangeStart must not be after now");
    expect(() =>
      aggregateSleepAnalytics(Array.from({ length: 100_001 }, () => ({}))),
    ).toThrow("at most 100000 items");
    expect(() =>
      aggregateSleepAnalytics([], undefined, new Date(), undefined, [
        "x".repeat(65),
      ]),
    ).toThrow("array of strings");
  });

  it("does not restart a nap for repeated sleep events", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:00:00Z", event_value: 4 },
        { event_time: "2026-01-01T00:30:00Z", event_value: 4 },
        { event_time: "2026-01-01T01:00:00Z", event_value: 1 },
      ],
      undefined,
      new Date("2026-01-01T02:00:00Z"),
    );
    expect(analytics.napCount).toBe(1);
    expect(analytics.totalSleepMinutes).toBe(60);
    expect(analytics.longestNapMinutes).toBe(60);
    expect(analytics.lastNapStart).toBe("2026-01-01T00:00:00Z");
  });

  it("ends sleep at stirring without counting stirring as awake", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:00:00Z", event_value: 4 },
        { event_time: "2026-01-01T00:30:00Z", event_value: 2 },
        { event_time: "2026-01-01T01:00:00Z", event_value: 1 },
      ],
      undefined,
      new Date("2026-01-01T01:20:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(30);
    expect(analytics.totalAwakeMinutes).toBe(20);
    expect(analytics.lastNapEnd).toBe("2026-01-01T00:30:00Z");
  });

  it("derives awake duration from state-one intervals", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:00:00Z", event_value: 1 },
        { event_time: "2026-01-01T00:15:00Z", event_value: 5 },
        { event_time: "2026-01-01T00:45:00Z", event_value: 4 },
      ],
      undefined,
      new Date("2026-01-01T01:00:00Z"),
    );
    expect(analytics.totalAwakeMinutes).toBe(15);
    expect(analytics.totalSleepMinutes).toBe(15);
  });

  it("rounds aggregate milliseconds once like the Android client", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:00:00.000Z", event_value: 1 },
        { event_time: "2026-01-01T00:00:30.000Z", event_value: 1 },
        { event_time: "2026-01-01T00:01:00.000Z", event_value: 4 },
        { event_time: "2026-01-01T00:01:20.000Z", event_value: 0 },
        { event_time: "2026-01-01T00:01:40.000Z", event_value: 4 },
        { event_time: "2026-01-01T00:02:00.000Z", event_value: 0 },
      ],
      undefined,
      new Date("2026-01-01T00:02:00.000Z"),
    );
    expect(analytics.totalAwakeMinutes).toBe(1);
    expect(analytics.totalSleepMinutes).toBe(1);
    expect(analytics.napCount).toBe(2);
    expect(analytics.longestNapMinutes).toBe(0);
  });

  it("interprets raw naive event timestamps as UTC", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-03-08 01:30:00.000000", event_value: 4 },
        { event_time: "2026-03-08 03:30:00.000000", event_value: 1 },
      ],
      undefined,
      new Date("2026-03-08T08:00:00Z"),
      "America/New_York",
    );
    expect(analytics.totalSleepMinutes).toBe(120);
    expect(analytics.longestNapMinutes).toBe(120);
    expect(
      parseEventTime("2026-03-08 03:30:00.000000", "America/New_York") -
        parseEventTime("2026-03-08 01:30:00.000000", "America/New_York"),
    ).toBe(60 * 60_000);
  });

  it("rejects normalized calendar and clock timestamps", () => {
    expect(parseEventTime("2026-02-29 00:00:00", "UTC")).toBeNaN();
    expect(parseEventTime("2026-04-31T00:00:00Z")).toBeNaN();
    expect(parseEventTime("2026-01-01 24:00:00", "UTC")).toBeNaN();
    expect(parseEventTime("2026-02-29")).toBeNaN();
    expect(parseEventTime("01/02/2026")).toBeNaN();
    expect(parseEventTime("2026-01-01 00:00:00", "Not/A_Timezone")).toBeNaN();
    expect(parseEventTime("2026-01-01 00:00:00", "")).toBeNaN();
    expect(parseEventTime("2026-01-01 00:00:00", " UTC ")).toBeNaN();
    expect(Number.isFinite(parseEventTime("2024-02-29 23:59:59", "UTC"))).toBe(
      true,
    );
    expect(parseEventTime("2026-01-01 00:00:00.250+05:30")).toBe(
      Date.UTC(2025, 11, 31, 18, 30, 0, 250),
    );
    expect(parseEventTime("2026-01-01 00:00:00.250-03:45")).toBe(
      Date.UTC(2026, 0, 1, 3, 45, 0, 250),
    );
    expect(parseEventTime(`2026-01-01 00:00:00.${"1".repeat(64)}`)).toBeNaN();
    expect(parseEventTime("2026-01-01 00:00:00", "UTC\nignored")).toBeNaN();
  });

  it("does not apply display timezone metadata to raw events", () => {
    const analytics = aggregateSleepAnalytics(
      [{ event_time: "2026-01-01 00:00:00.000000", event_value: 4 }],
      undefined,
      new Date("2026-01-01T01:00:00Z"),
      "Not/A_Timezone",
    );
    expect(analytics.napCount).toBe(1);
    expect(analytics.totalSleepMinutes).toBe(60);
  });

  it("sorts timestamped events before calculating naps", () => {
    const analytics = aggregateSleepAnalytics(
      [
        { event_time: "2026-01-01T00:40:00Z", event_value: 1 },
        { event_time: "invalid", event_value: 4, soothe_count: 2 },
        {
          event_time: "2026-01-01T00:00:00Z",
          event_value: 4,
          soothe_count: 1,
        },
      ],
      undefined,
      new Date("2026-01-01T01:00:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(40);
    expect(analytics.totalSootheCount).toBe(1);
    expect(analytics.lastEventTime).toBe("2026-01-01T00:40:00Z");
    expect(analytics.lastEventValue).toBe("awake");
  });

  it("merges the current analyticsV3 metric schema", () => {
    const analytics = aggregateSleepAnalytics([], {
      sleep_sessions: [
        { date: "2026-01-01", value: [100, 20] },
        { date: "2026-01-02", value: [80] },
      ],
      awake_sessions: [{ date: "2026-01-01", value: [15, 5] }],
      auto_soothe_counts: 4,
    });
    expect(analytics.totalSleepMinutes).toBe(200);
    expect(analytics.totalAwakeMinutes).toBe(20);
    expect(analytics.totalSootheCount).toBe(4);
  });

  it("uses current soothe-session evidence when aggregate counts are absent", () => {
    const fromEvents = aggregateSleepAnalytics(
      [{ event_value: 4, soothe_count: 9 }],
      undefined,
      new Date("2026-01-02T00:00:00Z"),
      undefined,
      ["2026-01-01 00:00:00", "2026-01-01 00:10:00"],
    );
    expect(fromEvents.totalSootheCount).toBe(2);

    const fromAnalytics = aggregateSleepAnalytics([], {
      auto_soothe_events: ["a", "b", "c"],
    });
    expect(fromAnalytics.totalSootheCount).toBe(3);
  });

  it("ignores negative duration and soothe metrics", () => {
    const analytics = aggregateSleepAnalytics(
      [
        {
          event_time: "2026-01-01T00:00:00Z",
          event_value: 4,
          soothe_count: -3,
        },
      ],
      {
        total_sleep: -10,
        sleep_sessions: [{ value: [-20, 15] }],
        total_awake: -5,
        awake_sessions: [{ value: [-4, 6] }],
        auto_soothe_counts: -2,
      },
      new Date("2026-01-01T00:10:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(15);
    expect(analytics.totalAwakeMinutes).toBe(6);
    expect(analytics.totalSootheCount).toBe(0);
  });

  it("rejects event soothe totals that exceed a safe integer", () => {
    expect(() =>
      aggregateSleepAnalytics(
        [
          {
            event_time: "2026-01-01T00:00:00Z",
            event_value: 4,
            soothe_count: Number.MAX_SAFE_INTEGER,
          },
          {
            event_time: "2026-01-01T00:01:00Z",
            event_value: 4,
            soothe_count: 1,
          },
        ],
        undefined,
        new Date("2026-01-01T00:10:00Z"),
      ),
    ).toThrow("safe integer");
  });

  it("does not let malformed metric containers erase computed totals", () => {
    const analytics = aggregateSleepAnalytics(
      [{ event_time: "2026-01-01T00:00:00Z", event_value: 4 }],
      {
        sleep_sessions: [{ value: ["invalid", -1] }],
        awake_sessions: [{ value: ["invalid"] }, null],
      },
      new Date("2026-01-01T00:10:00Z"),
    );
    expect(analytics.totalSleepMinutes).toBe(10);
    expect(analytics.totalAwakeMinutes).toBe(0);
    expect(
      aggregateSleepAnalytics(
        [{ event_time: "2026-01-01T00:00:00Z", event_value: 1 }],
        { awake_sessions: [{ value: ["invalid", -1] }] },
        new Date("2026-01-01T00:05:00Z"),
      ).totalAwakeMinutes,
    ).toBe(5);
    expect(
      aggregateSleepAnalytics([], { sleep_sessions: [] }).totalSleepMinutes,
    ).toBe(0);
  });

  it("maps known and unknown values", () => {
    expect(sleepPhaseName(6)).toBe("stirring");
    expect(sleepPhaseName(9)).toBe("9");
    expect(sleepPhaseName("custom")).toBe("custom");
    expect(sleepPhaseName(" ")).toBe(" ");
    expect(sleepPhaseName("0x4")).toBe("0x4");
    expect(sleepPhaseName("1e0")).toBe("1e0");
    expect(sleepPhaseName(" +4 ")).toBe("sleep");
    expect(sleepPhaseName(true)).toBe("true");
    expect(sleepPhaseName(false)).toBe("false");
    expect(sleepPhaseName(Symbol("phase"))).toBeUndefined();
    expect(sleepPhaseName(undefined)).toBeUndefined();
    expect(parseEventTime(1 as never)).toBeNaN();
  });

  it("preserves aggregate invariants across shuffled event streams", () => {
    let seed = 0x9e3779b9;
    const next = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const now = new Date("2026-01-02T00:00:00Z");
    const phases = [0, 1, 2, 4, 5, 6, "awake", "custom", null] as const;

    for (let run = 0; run < 500; run += 1) {
      const events = Array.from({ length: Math.floor(next() * 80) }, () => {
        const minutes = Math.floor(next() * 1_800) - 120;
        return {
          event_time:
            next() > 0.08
              ? new Date(now.getTime() - minutes * 60_000).toISOString()
              : "invalid",
          event_value: phases[Math.floor(next() * phases.length)] ?? null,
          soothe_count: Math.floor(next() * 8) - 2,
        };
      });
      for (let index = events.length - 1; index > 0; index -= 1) {
        const target = Math.floor(next() * (index + 1));
        [events[index], events[target]] = [events[target]!, events[index]!];
      }

      const analytics = aggregateSleepAnalytics(events, undefined, now);
      for (const metric of [
        analytics.totalSleepMinutes,
        analytics.totalAwakeMinutes,
        analytics.totalSootheCount,
        analytics.napCount,
        analytics.longestNapMinutes,
      ]) {
        expect(Number.isSafeInteger(metric)).toBe(true);
        expect(metric).toBeGreaterThanOrEqual(0);
      }
      expect(analytics.longestNapMinutes).toBeLessThanOrEqual(
        analytics.totalSleepMinutes,
      );
    }
  });
});
