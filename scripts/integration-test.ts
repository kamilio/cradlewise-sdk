import assert from "node:assert/strict";
import {
  aggregateSleepAnalytics,
  CradlewiseAuth,
  CradlewiseClient,
  getAppConfig,
} from "../src/index.js";

const email = process.env.CRADLEWISE_LOGIN;
const password = process.env.CRADLEWISE_PASSWORD;
if (!email || !password)
  throw new Error("CRADLEWISE_LOGIN and CRADLEWISE_PASSWORD are required");
const submittedEmail = email;
const submittedPassword = password;

await runIntegrationTest().catch(() => {
  throw new Error("Cradlewise integration test failed.");
});

async function runIntegrationTest(): Promise<void> {
  const config = await getAppConfig();
  const cachedConfig = await getAppConfig();
  assert.ok(
    JSON.stringify(cachedConfig.toJSON()) === JSON.stringify(config.toJSON()),
    "Cached configuration must match the discovered configuration",
  );
  console.log(`Configuration loaded and cache reuse verified`);

  const auth = new CradlewiseAuth({
    email: submittedEmail,
    password: submittedPassword,
    appConfig: config,
  });
  const credentials = await auth.authenticate();
  const reusedCredentials = await auth.ensureValid();
  assert.notEqual(reusedCredentials, credentials);
  assert.equal(
    reusedCredentials.aws.expiration.getTime(),
    credentials.aws.expiration.getTime(),
  );
  assert.equal(
    reusedCredentials.tokens.expiresAt.getTime(),
    credentials.tokens.expiresAt.getTime(),
  );
  assert.ok(
    reusedCredentials.aws.accessKeyId === credentials.aws.accessKeyId &&
      reusedCredentials.aws.sessionToken === credentials.aws.sessionToken &&
      reusedCredentials.tokens.idToken === credentials.tokens.idToken,
    "Credential reuse must preserve the authenticated credential set",
  );
  console.log(`Authentication and in-memory credential reuse verified`);

  const client = new CradlewiseClient(auth);
  const cradles = await client.discoverCradles();
  assert.ok(cradles.size > 0, "Expected at least one paired crib");
  console.log(`Discovered ${cradles.size} crib(s)`);

  let totalEvents = 0;
  let readableSources = 0;
  let completeStatusCribs = 0;
  for (const cradle of cradles.values()) {
    assert.ok(cradle.babyId, "Discovered crib is missing its baby profile ID");
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 86_400_000);
    const [state, online, firmware, eventData, serverAnalytics, timeline] =
      await Promise.allSettled([
        client.getCradleState(cradle.cradleId),
        client.getCradleOnlineStatus(cradle.cradleId),
        client.getFirmwareData(cradle.cradleId),
        client.getSleepEventsData(cradle.babyId, { startDate, endDate }),
        client.getAnalytics(cradle.babyId, { startDate, endDate }),
        client.getStatusTimeline(cradle.babyId, cradle.cradleId),
      ]);

    for (const [result, description] of [
      [state, "crib state"],
      [online, "online status"],
      [firmware, "firmware data"],
      [serverAnalytics, "sleep analytics"],
      [timeline, "status timeline"],
    ] as const) {
      if (result.status !== "fulfilled") continue;
      assertRecord(result.value, description);
      readableSources += 1;
    }
    if (eventData.status === "fulfilled") {
      assert.ok(Array.isArray(eventData.value.events));
      totalEvents += eventData.value.events.length;
      readableSources += 1;
    }

    const modelUpdate = await Promise.allSettled([client.updateCradle(cradle)]);
    if (modelUpdate[0].status === "fulfilled") {
      assert.equal(
        cradle.statusPartial,
        cradle.unavailableStatusSources.length > 0,
      );
      if (!cradle.statusPartial) {
        completeStatusCribs += 1;
        assert.equal(typeof cradle.babyPresent, "boolean");
        assert.equal(typeof cradle.online, "boolean");
        assert.equal(typeof cradle.firmwareVersion, "string");
        assert.equal(typeof cradle.serialNumber, "string");
        assert.equal(typeof cradle.cradleMode, "string");
        assert.ok(
          cradle.bounceSetting === undefined ||
            typeof cradle.bounceSetting === "string" ||
            typeof cradle.bounceSetting === "number",
        );
      }
    }

    if (
      eventData.status === "fulfilled" ||
      serverAnalytics.status === "fulfilled"
    ) {
      const analytics = aggregateSleepAnalytics(
        eventData.status === "fulfilled" ? eventData.value.events : [],
        serverAnalytics.status === "fulfilled"
          ? serverAnalytics.value
          : undefined,
        endDate,
        eventData.status === "fulfilled"
          ? (eventData.value.timezone ?? cradle.timezone)
          : cradle.timezone,
        eventData.status === "fulfilled"
          ? eventData.value.sleep_sessions_saved
          : undefined,
      );
      assertNonnegativeAnalytics(analytics);
    }
    const fetchedAnalytics = await Promise.allSettled([
      client.fetchSleepAnalytics(cradle, { startDate, endDate }),
    ]);
    if (fetchedAnalytics[0].status === "fulfilled") {
      assertNonnegativeAnalytics(fetchedAnalytics[0].value);
      readableSources += 1;
    }
  }

  console.log(
    `Verified account discovery and ${readableSources} readable cloud source(s) for ${cradles.size} crib(s); ${completeStatusCribs} crib(s) had complete live status and ${totalEvents} event(s) were available in the seven-day range`,
  );
}

function assertNonnegativeAnalytics(result: {
  totalSleepMinutes: number;
  totalAwakeMinutes: number;
  totalSootheCount: number;
  napCount: number;
  longestNapMinutes: number;
}): void {
  for (const [name, value] of Object.entries({
    totalSleepMinutes: result.totalSleepMinutes,
    totalAwakeMinutes: result.totalAwakeMinutes,
    totalSootheCount: result.totalSootheCount,
    napCount: result.napCount,
    longestNapMinutes: result.longestNapMinutes,
  })) {
    assert.ok(
      Number.isSafeInteger(value) && value >= 0,
      `${name} must be a nonnegative safe integer`,
    );
  }
}

function assertRecord(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${description} must be an object`,
  );
}
