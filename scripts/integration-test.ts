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

const config = await getAppConfig();
const cachedConfig = await getAppConfig();
assert.ok(
  JSON.stringify(cachedConfig.toJSON()) === JSON.stringify(config.toJSON()),
  "Cached configuration must match the discovered configuration",
);
console.log(`Configuration loaded and cache reuse verified`);

const auth = new CradlewiseAuth({ email, password, appConfig: config });
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
for (const cradle of cradles.values()) {
  assert.ok(cradle.babyId, "Discovered crib is missing its baby profile ID");
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 86_400_000);
  const [state, online, firmware, eventData, serverAnalytics, timeline] =
    await Promise.all([
      client.getCradleState(cradle.cradleId),
      client.getCradleOnlineStatus(cradle.cradleId),
      client.getFirmwareData(cradle.cradleId),
      client.getSleepEventsData(cradle.babyId, { startDate, endDate }),
      client.getAnalytics(cradle.babyId, { startDate, endDate }),
      client.getStatusTimeline(cradle.babyId, cradle.cradleId),
    ]);

  assertRecord(state, "crib state");
  assertRecord(online, "online status");
  assertRecord(firmware, "firmware data");
  assertRecord(serverAnalytics, "sleep analytics");
  assertRecord(timeline, "status timeline");
  assert.ok(Array.isArray(eventData.events));

  await client.updateCradle(cradle);
  assert.equal(cradle.statusPartial, false);
  assert.deepEqual(cradle.unavailableStatusSources, []);
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

  const analytics = aggregateSleepAnalytics(
    eventData.events,
    serverAnalytics,
    endDate,
    eventData.timezone ?? cradle.timezone,
    eventData.sleep_sessions_saved,
  );
  const fetchedAnalytics = await client.fetchSleepAnalytics(cradle, {
    startDate,
    endDate,
  });
  assert.equal(fetchedAnalytics.partial, false);
  assert.deepEqual(fetchedAnalytics.unavailableSources, []);
  for (const result of [analytics, fetchedAnalytics]) {
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

  totalEvents += eventData.events.length;
}

console.log(
  `Verified typed model state, firmware, events, analytics, and timeline for ${cradles.size} crib(s); ${totalEvents} event(s) in the seven-day range`,
);

function assertRecord(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${description} must be an object`,
  );
}
