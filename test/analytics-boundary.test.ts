import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateSleepAnalytics,
  AppConfig,
  Cradle,
  CradlewiseClient,
} from "../src/index.js";
import type { SleepEvent } from "../src/index.js";

const START = new Date("2026-08-26T12:00:00Z");
const END = new Date("2026-08-26T13:00:00Z");
const PRIOR = { event_time: "2026-08-26T11:30:00Z", event_value: 4 };
const WAKE = { event_time: "2026-08-26T12:00:00Z", event_value: 1 };

function summarize(events: SleepEvent[], start = START, end = END) {
  const before = structuredClone(events);
  const result = aggregateSleepAnalytics(
    events,
    undefined,
    end,
    "UTC",
    undefined,
    start,
  );
  expect(events).toEqual(before);
  expect(result.events).toEqual(before);
  return result;
}

function expectNoNap(result: ReturnType<typeof summarize>) {
  expect(result.napCount).toBe(0);
  expect(result.longestNapMinutes).toBe(0);
  expect(result.lastNapStart).toBeUndefined();
  expect(result.lastNapEnd).toBeUndefined();
  expect(result.toJSON()).toMatchObject({ napCount: 0, longestNapMinutes: 0 });
  expect(result.toJSON()).not.toHaveProperty("lastNapStart");
  expect(result.toJSON()).not.toHaveProperty("lastNapEnd");
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request"),
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("real events at the sleep range boundary", () => {
  it.each([0, 1, 2, 3, 5, 6, "1"])(
    "does not turn prior sleep into a nap before boundary state %s",
    (state) => {
      const result = summarize([PRIOR, { ...WAKE, event_value: state }]);
      expectNoNap(result);
      expect(result.totalSleepMinutes).toBe(0);
      expect(result.totalAwakeMinutes).toBe(
        state === 1 || state === "1" ? 60 : 0,
      );
    },
  );

  it.each([
    "2026-08-26T12:00:00Z",
    "2026-08-26T12:00:00.000Z",
    "2026-08-26 12:00:00",
    "2026-08-26T07:00:00-05:00",
  ])("compares instants rather than timestamp spelling: %s", (eventTime) => {
    expectNoNap(summarize([PRIOR, { ...WAKE, event_time: eventTime }]));
  });

  it("handles unsorted records and repeated boundary wakes", () => {
    const result = summarize([WAKE, { ...WAKE }, PRIOR]);
    expectNoNap(result);
    expect(result.totalAwakeMinutes).toBe(60);
    expect(result.lastEventTime).toBe(WAKE.event_time);
    expect(result.lastEventValue).toBe("awake");
  });

  it("does not invent a nap in an empty range ending at the wake", () => {
    expectNoNap(summarize([PRIOR, WAKE], START, START));
  });

  it("handles a real wake at the Unix epoch boundary", () => {
    const result = summarize(
      [
        { event_time: "1969-12-31T23:30:00Z", event_value: 4 },
        { event_time: "1970-01-01T00:00:00Z", event_value: 1 },
      ],
      new Date(0),
      new Date(3_600_000),
    );
    expectNoNap(result);
    expect(result.totalAwakeMinutes).toBe(60);
  });

  it("counts only a later real nap after a boundary wake", () => {
    const result = summarize([
      PRIOR,
      WAKE,
      { event_time: "2026-08-26T12:15:00Z", event_value: 4 },
      { event_time: "2026-08-26T12:30:00Z", event_value: 1 },
    ]);
    expect(result.napCount).toBe(1);
    expect(result.longestNapMinutes).toBe(15);
    expect(result.totalSleepMinutes).toBe(15);
    expect(result.totalAwakeMinutes).toBe(45);
    expect(result.lastNapStart).toBe("2026-08-26T12:15:00Z");
    expect(result.lastNapEnd).toBe("2026-08-26T12:30:00Z");
  });

  it.each([
    { start: "2026-08-26T11:59:00Z", naps: 1, minutes: 1 },
    { start: "2026-08-26T11:59:59Z", naps: 1, minutes: 0 },
    { start: "2026-08-26T12:00:01Z", naps: 0, minutes: 0 },
  ])(
    "retains adjacent-boundary behavior at $start",
    ({ start, naps, minutes }) => {
      const result = summarize([PRIOR, WAKE], new Date(start));
      expect(result.napCount).toBe(naps);
      expect(result.totalSleepMinutes).toBe(minutes);
      expect(result.longestNapMinutes).toBe(minutes);
      if (naps) {
        expect(result.lastNapStart).toBe(new Date(start).toISOString());
        expect(result.lastNapEnd).toBe(WAKE.event_time);
      } else expectNoNap(result);
    },
  );

  it("continues earlier sleep when no event exists at the boundary", () => {
    const result = summarize([
      PRIOR,
      { event_time: "2026-08-26T12:30:00Z", event_value: 1 },
    ]);
    expect(result.napCount).toBe(1);
    expect(result.totalSleepMinutes).toBe(30);
    expect(result.totalAwakeMinutes).toBe(30);
    expect(result.lastNapStart).toBe(START.toISOString());
  });

  it("continues an ongoing nap with no in-range events", () => {
    const result = summarize([PRIOR]);
    expect(result.napCount).toBe(1);
    expect(result.totalSleepMinutes).toBe(60);
    expect(result.lastNapEnd).toBeUndefined();
  });

  it.each([1, 4])("keeps real boundary sleep after prior state %s", (state) => {
    const result = summarize([
      { ...PRIOR, event_value: state },
      { ...WAKE, event_value: 4 },
    ]);
    expect(result.napCount).toBe(1);
    expect(result.totalSleepMinutes).toBe(60);
    expect(result.longestNapMinutes).toBe(60);
  });

  it("does not require a prior event to recognize a boundary wake", () => {
    expectNoNap(summarize([WAKE]));
  });

  it("retains unbounded history and its completed nap", () => {
    const result = aggregateSleepAnalytics([PRIOR, WAKE], undefined, END);
    expect(result.napCount).toBe(1);
    expect(result.totalSleepMinutes).toBe(30);
    expect(result.lastNapStart).toBe(PRIOR.event_time);
  });

  it("preserves saved soothe evidence independently of nap seeding", () => {
    const result = aggregateSleepAnalytics(
      [{ ...PRIOR, soothe_count: 9 }, WAKE],
      undefined,
      END,
      "UTC",
      [PRIOR.event_time, WAKE.event_time, "2026-08-26T12:15:00Z"],
      START,
    );
    expectNoNap(result);
    expect(result.totalSootheCount).toBe(2);
  });
});

describe("public sleep analytics boundary results", () => {
  for (const metricsAvailable of [false, true]) {
    it.each([
      { start: "2026-08-26T12:00:00Z", naps: 0, minutes: 0 },
      { start: "2026-08-26T12:00:01Z", naps: 0, minutes: 0 },
      { start: "2026-08-26T11:59:00Z", naps: 1, minutes: 1 },
    ])(
      `returns correct cached and serialized counts, metrics=${metricsAvailable}, start=$start`,
      async ({ start, naps, minutes }) => {
        const credentials = {
          identityId: "fixture-identity",
          tokens: {
            accessToken: "fixture-access",
            idToken: "fixture-id",
            expiresAt: new Date("2030-01-01T00:00:00Z"),
          },
          aws: {
            accessKeyId: "AKIDEXAMPLE",
            secretAccessKey: "offline-fixture-only",
            sessionToken: "fixture-session",
            expiration: new Date("2030-01-01T00:00:00Z"),
          },
        };
        const auth = {
          email: "fixture@example.invalid",
          credentials,
          appConfig: new AppConfig({
            cognitoUserPoolId: "fixture-pool",
            cognitoAppClientId: "fixture-client",
            cognitoAppClientSecret: "fixture-secret",
            cognitoIdentityPoolId: "fixture-identity",
            cognitoRegion: "us-east-1",
            apiBaseUrl: "https://backend.cradlewise.com",
          }),
          ensureValid: () => Promise.resolve(credentials),
          authenticate: () => Promise.resolve(credentials),
          clearCredentials: () => undefined,
        };
        const requests: URL[] = [];
        const client = new CradlewiseClient(auth as never, {
          fetch: (input, init) => {
            const url = new URL(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            );
            expect(url.hostname).toBe("backend.cradlewise.com");
            expect(init?.method).toBe("GET");
            requests.push(url);
            if (url.pathname.endsWith("/eventsV3"))
              return Promise.resolve(Response.json({ events: [PRIOR, WAKE] }));
            expect(url.pathname.endsWith("/analyticsV3")).toBe(true);
            return Promise.resolve(
              metricsAvailable
                ? Response.json({ total_sleep: 17, total_awake: 23 })
                : Response.json(
                    { message: "Fixture metrics unavailable" },
                    { status: 503 },
                  ),
            );
          },
        });
        const result = await client.fetchSleepAnalytics(
          new Cradle({
            cradleId: "fixture-crib",
            babyId: "fixture-baby",
            timezone: "UTC",
          }),
          { startDate: start, endDate: END, timezone: "UTC" },
        );
        expect(result.partial).toBe(!metricsAvailable);
        expect(result.unavailableSources).toEqual(
          metricsAvailable ? [] : ["analytics"],
        );
        expect(result.napCount).toBe(naps);
        expect(result.totalSleepMinutes).toBe(metricsAvailable ? 17 : minutes);
        expect(result.totalAwakeMinutes).toBe(metricsAvailable ? 23 : 60);
        expect(result.longestNapMinutes).toBe(minutes);
        expect(result.toJSON().napCount).toBe(naps);
        expect(client.analytics.get("fixture-baby")).toBe(result);
        if (!naps) expectNoNap(result);
        expect(requests).toHaveLength(2);
        expect(
          requests.map((url) => url.searchParams.get("start_date")),
        ).toEqual([
          start.replace("T", " ").replace("Z", ""),
          start.replace("T", " ").replace("Z", ""),
        ]);
      },
    );
  }
});
