import { describe, expect, it } from "vitest";
import { Cradle, SleepAnalytics } from "../src/models.js";

describe("Cradle", () => {
  it("rejects path-unsafe crib identifiers", () => {
    for (const cradleId of [
      ".",
      "..",
      "crib/other",
      "crib\\other",
      "crib%2Fother",
      "crib?other",
      "crib#other",
    ]) {
      expect(() => new Cradle({ cradleId })).toThrow("cradleId");
    }
  });

  it("preserves present empty optional strings when serialized", () => {
    const cradle = new Cradle({
      cradleId: "crib",
      babyId: "",
      babyName: "",
      firmwareVersion: "",
      timezone: "",
      serialNumber: "",
      state: { babySleepPhase: "" },
    });
    expect(cradle.toJSON()).toMatchObject({
      babyId: "",
      babyName: "",
      firmwareVersion: "",
      timezone: "",
      serialNumber: "",
      sleepPhaseName: "",
    });
  });

  it("snapshots crib constructor option getters once", () => {
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    const values = {
      cradleId: "crib",
      babyId: "baby",
      babyName: "Baby",
      firmwareVersion: "1.0",
      timezone: "UTC",
      serialNumber: "serial",
      state: { online: true },
      online: true,
      statusPartial: false,
      unavailableStatusSources: [] as string[],
    };
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const cradle = new Cradle(options as never);

    expect(cradle.cradleId).toBe("crib");
    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
    );
  });

  it("rejects malformed crib identifiers", () => {
    expect(() => new Cradle(null as never)).toThrow("plain object");
    expect(() => new Cradle({ cradleId: "" })).toThrow(TypeError);
    expect(() => new Cradle({ cradleId: " crib " })).toThrow(TypeError);
    expect(() => new Cradle({ cradleId: "crib\nnext" })).toThrow(TypeError);
    expect(() => new Cradle({ cradleId: "a".repeat(257) })).toThrow(TypeError);
    expect(() => new Cradle({ cradleId: "crib", babyId: 1 as never })).toThrow(
      "babyId must be a string",
    );
    expect(
      () => new Cradle({ cradleId: "crib", babyId: "baby/other" }),
    ).toThrow("babyId");
    expect(
      () => new Cradle({ cradleId: "crib", babyName: "bad\nname" }),
    ).toThrow("control-free");
    expect(
      () => new Cradle({ cradleId: "crib", serialNumber: "a".repeat(4097) }),
    ).toThrow("4096 bytes");
    expect(
      () => new Cradle({ cradleId: "crib", online: "yes" as never }),
    ).toThrow("online must be a boolean");
    expect(
      () => new Cradle({ cradleId: "crib", statusPartial: 1 as never }),
    ).toThrow("statusPartial must be a boolean");
    expect(
      () =>
        new Cradle({
          cradleId: "crib",
          unavailableStatusSources: ["other"] as never,
        }),
    ).toThrow("unavailableStatusSources");
    expect(
      () =>
        new Cradle({
          cradleId: "crib",
          unavailableStatusSources: ["online", "online"],
        }),
    ).toThrow("duplicates");
    expect(() => new Cradle({ cradleId: "crib", statusPartial: true })).toThrow(
      "must match",
    );
    expect(
      () =>
        new Cradle({
          cradleId: "crib",
          statusPartial: false,
          unavailableStatusSources: ["online"],
        }),
    ).toThrow("must match");
    expect(() => new Cradle({ cradleId: "crib", state: [] as never })).toThrow(
      "plain object",
    );
    const cradle = new Cradle({ cradleId: "crib" });
    expect(
      () => (cradle.unavailableStatusSources = ["online", "online"]),
    ).toThrow("duplicates");
    expect(
      () =>
        (cradle.unavailableStatusSources = [
          "state",
          "online",
          "firmware",
          "state",
        ]),
    ).toThrow("unavailableStatusSources");
    const indexedSources = ["online"] as const;
    Object.defineProperty(indexedSources, Symbol.iterator, {
      value: () => {
        throw new Error("custom iterator must not run");
      },
    });
    cradle.unavailableStatusSources = indexedSources as unknown as ["online"];
    expect(cradle.unavailableStatusSources).toEqual(["online"]);
  });

  it("exposes typed state and computed values", () => {
    const cradle = new Cradle({
      cradleId: "crib-1",
      babyId: "baby-1",
      babyName: "Baby",
      online: true,
      statusPartial: true,
      unavailableStatusSources: ["online"],
      state: {
        babyPresent: true,
        babySleepPhaseV2: { eventValue: 4 },
        actuator: { on: true, amplitude: "3" },
        bounceLevel: 4,
        maxBounceLimit: 80,
        music: { play: true, volume: "7", mood: "calm" },
        musicLevel: 2,
        maxVolumeLimit: 60,
        light: { lightOn: true, lightIntensity: "2" },
        deviceStatus: {
          batteryLife: "88",
          charging: true,
          supplyRemoved: false,
        },
        mode: "normal",
      },
    });

    expect(cradle.babyPresent).toBe(true);
    expect(cradle.sleepPhaseRaw).toBe(4);
    expect(cradle.sleepPhaseName).toBe("sleep");
    expect(cradle.bouncing).toBe(true);
    expect(cradle.bounceAmplitude).toBe(3);
    expect(cradle.bounceIntensityLevel).toBe(5);
    expect(cradle.maxBouncePercent).toBe(80);
    expect(cradle.musicPlaying).toBe(true);
    expect(cradle.musicVolume).toBe(7);
    expect(cradle.musicIntensityLevel).toBe(3);
    expect(cradle.maxMusicPercent).toBe(60);
    expect(cradle.musicMood).toBe("calm");
    expect(cradle.lightOn).toBe(true);
    expect(cradle.lightIntensity).toBe(2);
    expect(cradle.batteryLife).toBe(88);
    expect(cradle.charging).toBe(true);
    expect(cradle.supplyRemoved).toBe(false);
    expect(cradle.cradleMode).toBe("normal");
    expect(cradle.toJSON()).toMatchObject({
      cradleId: "crib-1",
      sleepPhaseName: "sleep",
      statusPartial: true,
      unavailableStatusSources: ["online"],
    });
  });

  it("rejects invalid values introduced after model construction", () => {
    const cradle = new Cradle({ cradleId: "crib" });
    cradle.babyName = "invalid\nname";
    expect(() => cradle.toJSON()).toThrow("babyName");
    cradle.babyName = undefined;
    cradle.online = "yes" as never;
    expect(() => cradle.toJSON()).toThrow("online");

    const analytics = new SleepAnalytics();
    analytics.totalSleepMinutes = Number.NaN;
    expect(() => analytics.toJSON()).toThrow("totalSleepMinutes");
    analytics.totalSleepMinutes = 0;
    analytics.lastEventValue = "invalid\nvalue";
    expect(() => analytics.toJSON()).toThrow("lastEventValue");
  });

  it("derives partial status from unavailable sources", () => {
    const cradle = new Cradle({
      cradleId: "crib",
      unavailableStatusSources: ["firmware"],
    });

    expect(cradle.statusPartial).toBe(true);
  });

  it("maps current snake-case and raw-shadow state fields", () => {
    const cradle = new Cradle({
      cradleId: "crib-1",
      state: {
        baby_present: true,
        baby_sleep_state: "Sleeping",
        bounce_setting: 3,
        responsivity_setting: 2,
        music: { play: null, volume: null },
        soundSynth: { play: true, volume: 7, trackName: "rain" },
        rawShadow: {
          userSetCradleMode: "bassinet",
          bounceMode: 1,
          musicMode: 2,
          babySleepPhaseV2: { eventValue: "4" },
          light: { lightOn: true, lightIntensity: 5 },
          deviceStatus: { batteryLife: 90, charging: false },
        },
      },
    });

    expect(cradle.babyPresent).toBe(true);
    expect(cradle.babySleepState).toBe("Sleeping");
    expect(cradle.bounceSetting).toBe(3);
    expect(cradle.responsivitySetting).toBe(2);
    expect(cradle.cradleMode).toBe("bassinet");
    expect(cradle.bounceMode).toBe(1);
    expect(cradle.musicMode).toBe(2);
    expect(cradle.musicPlaying).toBe(true);
    expect(cradle.musicVolume).toBe(7);
    expect(cradle.musicMood).toBe("rain");
    expect(cradle.lightOn).toBe(true);
    expect(cradle.lightIntensity).toBe(5);
    expect(cradle.batteryLife).toBe(90);
    expect(cradle.charging).toBe(false);
    expect(cradle.sleepPhaseName).toBe("sleep");
  });

  it("deep-merges realtime state updates", () => {
    const cradle = new Cradle({
      cradleId: "crib-1",
      state: { music: { play: false, volume: 4 }, actuator: { on: false } },
    });
    cradle.updateState({ music: { play: true } });
    expect(cradle.state.music).toEqual({ play: true, volume: 4 });
    expect(cradle.state.actuator).toEqual({ on: false });
    expect(() => cradle.updateState(null as never)).toThrow("plain object");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => cradle.updateState(circular as never)).toThrow("circular");
    expect(() =>
      cradle.updateState({ updatedAt: new Date() } as never),
    ).toThrow("plain JSON objects");
    for (const invalid of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("state"),
      () => undefined,
    ]) {
      expect(() => cradle.updateState({ invalid } as never)).toThrow(
        "valid JSON values",
      );
    }
    const sparse = new Array(1);
    expect(() => cradle.updateState({ sparse })).toThrow(
      "must not contain holes",
    );

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 101; depth += 1) nested = { nested };
    expect(() => cradle.updateState(nested as never)).toThrow(
      "maximum nesting depth",
    );
    expect(() =>
      cradle.updateState({
        excessive: Array.from({ length: 100_001 }, () => null),
      }),
    ).toThrow("too many values");
    const largeText = "x".repeat(1024 * 1024);
    expect(() =>
      cradle.updateState({
        excessiveText: Array.from({ length: 17 }, () => largeText),
      }),
    ).toThrow("too much string data");
  });

  it("blocks prototype-altering keys in initial and merged state", () => {
    const initial = JSON.parse(
      '{"__proto__":{"polluted":true},"music":{"volume":4},"items":[{"constructor":{"prototype":{"polluted":true}},"safe":1}]}',
    );
    const update = JSON.parse(
      '{"constructor":{"prototype":{"polluted":true}},"music":{"play":true}}',
    );
    const cradle = new Cradle({ cradleId: "crib-1", state: initial });
    cradle.updateState(update);

    expect(cradle.state.music).toEqual({ volume: 4, play: true });
    expect(Reflect.get(cradle.state, "polluted")).toBeUndefined();
    expect(Object.hasOwn(cradle.state, "__proto__")).toBe(false);
    expect(Object.hasOwn(cradle.state, "constructor")).toBe(false);
    expect(cradle.state.items).toEqual([{ safe: 1 }]);
    expect(Reflect.get({}, "polluted")).toBeUndefined();

    const serialized = cradle.toJSON();
    (serialized.state as any).music.volume = 99;
    expect(cradle.state.music?.volume).toBe(4);
  });

  it("replaces state with an owned validated snapshot", () => {
    const cradle = new Cradle({ cradleId: "crib-1" });
    const state = { music: { volume: 4 } };
    cradle.replaceState(state);
    state.music.volume = 9;
    expect(cradle.state.music).toEqual({ volume: 4 });
    const snapshot = cradle.state;
    if (snapshot.music) snapshot.music.volume = 12;
    expect(cradle.state.music).toEqual({ volume: 4 });
    expect(Reflect.set(cradle, "cradleId", "other")).toBe(false);
    expect(cradle.cradleId).toBe("crib-1");
    cradle.unavailableStatusSources = ["online"];
    const unavailable = cradle.unavailableStatusSources;
    unavailable.length = 0;
    expect(cradle.statusPartial).toBe(true);
    expect(cradle.unavailableStatusSources).toEqual(["online"]);
    expect(Reflect.set(cradle, "statusPartial", false)).toBe(false);
    expect(() => cradle.replaceState([] as never)).toThrow("plain object");
  });

  it("handles raw and unknown sleep phases", () => {
    expect(
      new Cradle({
        cradleId: "1",
        state: {
          babySleepPhaseV2: { eventValue: "4" },
        },
      }).sleepPhaseRaw,
    ).toBe(4);
    expect(
      new Cradle({ cradleId: "1", state: { babySleepPhase: "1" } })
        .sleepPhaseName,
    ).toBe("awake");
    expect(
      new Cradle({ cradleId: "1", state: { babySleepPhase: 99 } })
        .sleepPhaseName,
    ).toBe("unknown (99)");
    expect(
      new Cradle({ cradleId: "1", state: { babySleepPhase: "napping" } })
        .sleepPhaseName,
    ).toBe("napping");
    expect(
      new Cradle({ cradleId: "1", state: { babySleepPhase: 4.5 } })
        .sleepPhaseRaw,
    ).toBeUndefined();
    const malformed = new Cradle({
      cradleId: "1",
      state: {
        babyPresent: "true" as never,
        mode: false as never,
        actuator: { on: "true" as never, amplitude: "0x10" },
        bounceLevel: 5,
        maxBounceLimit: 101,
        music: { volume: "1e2" },
        musicLevel: -1,
        maxVolumeLimit: 1.5,
        light: { lightIntensity: " " },
        deviceStatus: { batteryLife: {} as never, charging: "yes" as never },
      },
    });
    expect(malformed.babyPresent).toBeUndefined();
    expect(malformed.cradleMode).toBeUndefined();
    expect(malformed.bouncing).toBeUndefined();
    expect(malformed.bounceAmplitude).toBeUndefined();
    expect(malformed.bounceIntensityLevel).toBeUndefined();
    expect(malformed.maxBouncePercent).toBeUndefined();
    expect(malformed.musicVolume).toBeUndefined();
    expect(malformed.musicIntensityLevel).toBeUndefined();
    expect(malformed.maxMusicPercent).toBeUndefined();
    expect(malformed.lightIntensity).toBeUndefined();
    expect(malformed.batteryLife).toBeUndefined();
    expect(malformed.charging).toBeUndefined();
  });
});

describe("SleepAnalytics", () => {
  it("snapshots analytics constructor fields once", () => {
    const reads = new Map<string, number>();
    const data = {} as Record<string, unknown>;
    const values = {
      totalSleepMinutes: 1,
      totalAwakeMinutes: 2,
      totalSootheCount: 3,
      napCount: 4,
      longestNapMinutes: 5,
      lastNapStart: "start",
      lastNapEnd: "end",
      lastEventTime: "time",
      lastEventValue: "sleep",
      events: [] as unknown[],
      partial: false,
      unavailableSources: [] as string[],
    };
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(data, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const analytics = new SleepAnalytics(data);

    expect(analytics.totalSleepMinutes).toBe(1);
    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
    );
  });

  it("reads each analytics event array entry once", () => {
    let reads = 0;
    const events: unknown[] = [];
    Object.defineProperty(events, 0, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? { event_value: 4 } : null;
      },
    });
    events.length = 1;

    const analytics = new SleepAnalytics({ events: events as never });

    expect(reads).toBe(1);
    expect(analytics.events).toEqual([{ event_value: 4 }]);
  });

  it("rejects malformed constructor data", () => {
    expect(() => new SleepAnalytics(null as never)).toThrow("plain object");
    expect(() => new SleepAnalytics({ totalSleepMinutes: -1 })).toThrow(
      "nonnegative safe integer",
    );
    expect(() => new SleepAnalytics({ events: [null] as never })).toThrow(
      "plain objects",
    );
    expect(
      () =>
        new SleepAnalytics({
          events: Array.from({ length: 100_001 }, () => ({})),
        }),
    ).toThrow("at most 100000 items");
    const largeText = "x".repeat(1024 * 1024);
    expect(
      () =>
        new SleepAnalytics({
          events: Array.from({ length: 17 }, () => ({ value: largeText })),
        }),
    ).toThrow("too much string data");
    expect(
      () => new SleepAnalytics({ unavailableSources: ["other"] as never }),
    ).toThrow("events or analytics");
    expect(() => new SleepAnalytics({ partial: 1 as never })).toThrow(
      "partial must be a boolean",
    );
    expect(
      () => new SleepAnalytics({ unavailableSources: ["events", "events"] }),
    ).toThrow("duplicates");
    expect(() => new SleepAnalytics({ partial: true })).toThrow("must match");
    expect(
      () =>
        new SleepAnalytics({
          partial: false,
          unavailableSources: ["analytics"],
        }),
    ).toThrow("must match");
    const analytics = new SleepAnalytics();
    expect(() => (analytics.unavailableSources = ["events", "events"])).toThrow(
      "duplicates",
    );
    expect(
      () => (analytics.unavailableSources = ["events", "analytics", "events"]),
    ).toThrow("unavailableSources");
    const indexedSources = ["events"] as const;
    Object.defineProperty(indexedSources, Symbol.iterator, {
      value: () => {
        throw new Error("custom iterator must not run");
      },
    });
    analytics.unavailableSources = indexedSources as unknown as ["events"];
    expect(analytics.unavailableSources).toEqual(["events"]);
  });

  it("serializes only defined optional values", () => {
    const analytics = new SleepAnalytics({
      totalSleepMinutes: 42,
      lastNapStart: "start",
      lastEventValue: "",
    });
    expect(analytics.toJSON()).toMatchObject({
      totalSleepMinutes: 42,
      lastNapStart: "start",
      lastEventValue: "",
      partial: false,
      unavailableSources: [],
    });
    expect(analytics.toJSON()).not.toHaveProperty("lastNapEnd");
  });

  it("ignores prototype keys and owns mutable arrays", () => {
    const events = [{ event_time: "2026-01-01T00:00:00Z", event_value: 4 }];
    const sources = ["events"] as const;
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"totalSleepMinutes":7}',
    );
    input.events = events;
    input.unavailableSources = sources;
    const analytics = new SleepAnalytics(input);

    events.push({ event_time: "2026-01-01T01:00:00Z", event_value: 1 });
    expect(analytics.events).toHaveLength(1);
    expect(analytics.partial).toBe(true);
    expect(analytics.unavailableSources).toEqual(["events"]);
    expect(Reflect.get(analytics, "polluted")).toBeUndefined();
    expect(analytics).toBeInstanceOf(SleepAnalytics);

    const serialized = analytics.toJSON();
    serialized.events[0]!.event_value = 1;
    serialized.events.length = 0;
    serialized.unavailableSources.length = 0;
    expect(analytics.events).toHaveLength(1);
    expect(analytics.events[0]?.event_value).toBe(4);
    expect(analytics.unavailableSources).toEqual(["events"]);
    const unavailable = analytics.unavailableSources;
    unavailable.length = 0;
    expect(analytics.partial).toBe(true);
    expect(analytics.unavailableSources).toEqual(["events"]);
    expect(Reflect.set(analytics, "partial", false)).toBe(false);

    analytics.events.push(null as never);
    expect(() => analytics.toJSON()).toThrow("plain objects without holes");
    analytics.events.pop();
    analytics.events.length = 2;
    expect(() => analytics.toJSON()).toThrow("without holes");
  });
});
