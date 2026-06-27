# cradlewise

Unofficial, strongly typed Node.js client for the Cradlewise smart crib API. It supports Cognito SRP authentication, signed REST requests, crib discovery and state, sleep analytics, and Toolcraft-powered CLI/MCP access. A research-only legacy AWS IoT IAM transport is included but disabled by default because it is not compatible with the current mobile app's certificate-based realtime protocol.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Cradlewise. It uses private app APIs that may change without notice. Start with read-only use and never rely on it for safety-critical monitoring.

## Requirements

- Node.js 20.12 or newer
- A Cradlewise account paired with at least one crib
- ES modules; CommonJS callers must use dynamic `import()`

## Install

```sh
npm install cradlewise
```

## Quick start

```ts
import { CradlewiseAuth, CradlewiseClient, getAppConfig } from "cradlewise";

const appConfig = await getAppConfig();
const auth = new CradlewiseAuth({
  email: process.env.CRADLEWISE_LOGIN!,
  password: process.env.CRADLEWISE_PASSWORD!,
  appConfig,
});
const client = new CradlewiseClient(auth);

const cradles = await client.discoverCradles();
for (const cradle of cradles.values()) {
  await client.updateCradle(cradle);
  console.log({
    online: cradle.online,
    babyPresent: cradle.babyPresent,
    sleepPhase: cradle.sleepPhaseName,
    statusPartial: cradle.statusPartial,
    unavailableStatusSources: cradle.unavailableStatusSources,
    bouncing: cradle.bouncing,
    musicPlaying: cradle.musicPlaying,
    lightOn: cradle.lightOn,
  });
}
```

`getAppConfig()` discovers the current Cognito, API Gateway, and IoT settings from the published Android app and caches them in `~/.cradlewise/cradlewise_app_config.json`. Auto-discovery pins non-reversible fingerprints of the verified Cognito/identity/API configuration and AWS IoT endpoint in addition to the known `us-east-1` Cradlewise backend boundary, so a compromised mirror cannot substitute an attacker-controlled authentication pool or regional endpoint. Discovery streams the bounded XAPK/APK workspace and fails closed if cache, download, ZIP handle, or output cleanup cannot complete, retaining operation and cleanup failures together. `isTrustedDiscoveredAppConfig()` lets integrations revalidate reconstructed auto-discovery data before reuse; it is not a validator for caller-supplied explicit configurations. A legitimate upstream configuration rotation requires a package trust-fingerprint update or an explicitly verified `AppConfig`; production applications can construct `AppConfig` explicitly to remove the mirror/bootstrap dependency.

## Authentication

```ts
import { AppConfig, CradlewiseAuth } from "cradlewise";

const appConfig = new AppConfig({
  cognitoUserPoolId: process.env.CRADLEWISE_USER_POOL_ID!,
  cognitoAppClientId: process.env.CRADLEWISE_APP_CLIENT_ID!,
  cognitoAppClientSecret: process.env.CRADLEWISE_APP_CLIENT_SECRET!,
  cognitoIdentityPoolId: process.env.CRADLEWISE_IDENTITY_POOL_ID!,
  cognitoRegion: "us-east-1",
  apiBaseUrl: process.env.CRADLEWISE_API_BASE_URL!,
  iotEndpoint: process.env.CRADLEWISE_IOT_ENDPOINT,
});

const auth = new CradlewiseAuth({ email, password, appConfig });
await auth.authenticate();
```

An explicit API base URL must use `backend.cradlewise.com` or an AWS API Gateway hostname in the configured Cognito region. An explicit IoT endpoint must be an AWS IoT ATS hostname in that region. The exported `isApiBaseUrlForRegion()` and `isAwsIotEndpointForRegion()` helpers expose the same checks. These boundaries prevent temporary AWS credentials from being signed for unrelated hosts.

Credentials are held in memory only. `ensureValid()` coalesces concurrent login attempts and automatically reauthenticates before the Cognito or temporary AWS credentials expire. Authentication has a 30-second total timeout by default; set `authenticationTimeoutMs` on `CradlewiseAuth` when a verified environment needs another bound. The deadline is enforced even when a custom Cognito adapter ignores its abort signal. Email, password, challenge, token, and temporary-credential material also has conservative byte bounds before expensive cryptography or SDK handoff. `clearCredentials()` aborts any authentication exchange still in flight. Returned credential objects are independent snapshots, so caller mutation cannot corrupt the authentication client's internal validity state.

Public options and adapter results are read once into validated snapshots before use. This includes authentication challenges and credentials, REST request/query values and response metadata, sleep-query options, model inputs, and realtime credentials, so getters cannot change a trusted value between validation and execution. Outgoing JSON rejects non-finite numbers rather than silently converting them to `null`.

## REST API

`CradlewiseClient` currently exposes the read APIs established by the mobile app and `pycradlewise`:

| Area         | Methods                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| Discovery    | `getBabyProfiles()`, `getCradlesForBaby()`, `discoverCradles()`                                              |
| Crib         | `getCradleState()`, `getCradleOnlineStatus()`, `getFirmwareData()`, `updateCradle()`                         |
| Sleep        | `getSleepEventsData()`, `getSleepEvents()`, `getAnalytics()`, `getStatusTimeline()`, `fetchSleepAnalytics()` |
| Escape hatch | `request(method, path, options)` for unmodeled read endpoints                                                |

The generic request method permits only `GET` and `HEAD` by default. Pass query values through `options.query`; paths containing a query string, fragment, control character, backslash, literal or percent-encoded dot segment, malformed or invalid UTF-8 escape, encoded delimiter/separator/control, or encoded percent sign are rejected before authentication. Methods, paths, query counts, names, values, and serialized request bodies have conservative size bounds; request bodies are capped at 16 MiB. Query names must be nonempty, trimmed, control-free, and must not use prototype-sensitive names. State-changing methods require the explicit `allowStateChangingRequests: true` client option and should be enabled only after independently verifying an endpoint; the supported high-level API remains read-only. Opted-in state-changing requests are never automatically replayed after authentication errors.

Responses are streamed with a 16 MiB default byte limit and an 8,192-chunk ceiling. Set `maxResponseBytes` in `CradlewiseClient` options only when a verified endpoint requires a different bound. The 30-second request deadline is shared by the initial attempt and its single authorization retry and covers compatible-adapter credential acquisition, signing, authentication refresh, fetch, and response-body decoding even when an adapter ignores its abort signal. Late responses are canceled without awaiting untrusted cleanup promises; malformed UTF-8, non-finite JSON numbers, excessive nesting, and excessive JSON value counts are rejected.

Every request is signed with AWS Signature Version 4. A `GET` or `HEAD` response with status 401 or 403 triggers at most one retry; concurrent failures share one refresh, and late failures retry with credentials already refreshed by another request. Opted-in state-changing requests are never replayed.

`discoverCradles()` coalesces concurrent discovery calls, caps accepted profile and crib cardinality, limits follow-up request fanout to eight at a time, and preserves existing model instances for still-paired cribs so live state and caller references survive metadata refreshes. `updateCradle()` queries state, online status, and firmware independently. If one or two endpoints fail, it updates the successful fields and sets `statusPartial` plus `unavailableStatusSources`; fields owned by failed sources retain their prior values. If all three fail, it sets those diagnostics and throws `CradlewiseApiError` rather than presenting stale values as a complete update. Concurrent updates are generation-ordered so an older response cannot overwrite newer model data. Successful HTTP responses whose bodies do not match a recognized endpoint envelope are rejected instead of being treated as empty data.

## Sleep analytics

```ts
const analytics = await client.fetchSleepAnalytics(cradle, {
  startDate: "2026-06-01T00:00:00Z",
  endDate: "2026-06-08T00:00:00Z",
});
console.log(analytics.totalSleepMinutes);
console.log(analytics.totalSootheCount);
console.log(analytics.longestNapMinutes);
```

Sleep methods default to the preceding seven days. Dates may be `Date` instances, ISO strings, or UTC `yyyy-MM-dd HH:mm:ss` strings; raw event and soothe-session timestamps without an explicit offset are interpreted as UTC, matching the Android client's conversion path. The root `parseEventTime()` export provides the same strict parser and accepts an optional IANA timezone when a caller intentionally needs local-wall-clock interpretation. `getAnalytics()` defaults to the mobile app's current query contract: `metricName: "sleep_metrics"`, `metricFilter: "app"`, and `startHour: 8`. `getSleepEventsData()` preserves the response wrapper and timezone metadata, while `getSleepEvents()` returns only the event array.

The library calculates nap summaries from event intervals and then prefers server-provided totals where available. Sleep state `4` contributes sleep time, awake state `1` contributes awake time, and stirring/away intervals contribute neither; any non-sleep transition closes an active nap. Event-derived durations and soothe evidence are clipped to both requested range boundaries; a state already active at the lower boundary continues from that boundary without counting earlier elapsed time. When aggregate soothe counts are unavailable, the current `sleep_sessions_saved` event evidence is used. Event/model trees are capped by node, depth, and aggregate text budgets before cloning or aggregation.

If exactly one sleep source fails, `fetchSleepAnalytics()` returns the usable fallback with `partial: true` and names the missing source in `unavailableSources`. It throws if both sources fail or if the selected crib has no associated baby identifier. Each request snapshots the crib's baby identifier and timezone, and concurrent calls are generation-ordered so an older result cannot replace a newer cached result.

## Legacy realtime research transport

The legacy transport is excluded from default installs. Install its optional peer only when deliberately testing a verified legacy account:

```sh
npm install aws-iot-device-sdk-v2
```

```ts
import { CradlewiseRealtime } from "cradlewise";

const realtime = new CradlewiseRealtime({
  auth,
  client,
  cradleIds: cradles.keys(),
  allowLegacyIamAuthentication: true,
  onStateUpdate: () => console.log("Received a crib state update"),
});

realtime.on("error", (error) => console.error("Realtime error", error.message));
realtime.on("messageError", (error) =>
  console.error(
    "Realtime message error",
    error instanceof Error ? error.message : "Unknown error",
  ),
);
await realtime.connect();

// Later:
await realtime.disconnect();
```

The current Android app provisions a per-device private key and certificate through a device-registration flow, then connects with mutual TLS. That registration mutates account/device state and can consume a device slot, so this read-only package intentionally does not automate it. The included IAM WebSocket transport is retained only for verified legacy accounts and protocol research; it is disabled unless `allowLegacyIamAuthentication: true` is explicitly supplied. It is not expected to connect to the current service. Use REST polling for supported operation. Initial SDK loading, credential acquisition, connection, and subscription setup share one 30-second hard deadline by default; later MQTT operations receive the same per-operation bound. Set `operationTimeoutMs` only for a verified legacy environment. Timed-out connections and subscriptions are cleaned up if the SDK settles late. At most 100 crib IDs may be subscribed, credential validity is checked before SDK construction, and malformed, oversized, excessively nested, or non-JSON-safe payloads are contained and reported through `messageError`. Exceptions from state callbacks or `state` listeners are contained the same way. See `docs/realtime-and-toolcraft.md`.

`isRealtimeAvailable()` therefore returns `false` for the current supported protocol. `isLegacyRealtimeSdkAvailable()` only reports whether the optional legacy AWS IoT SDK is installed.

Realtime listeners are typed through the exported `CradlewiseRealtimeEventMap`. Serialized crib snapshots use the exported `CradleData` interface, while `Cradle.toJSON()` continues to return a defensive copy.

## CLI and MCP

The package uses [Toolcraft](https://github.com/poe-platform/poe-code/tree/main/packages/toolcraft) to define one read-only command tree for CLI, SDK, and MCP surfaces.

Toolcraft is a default-installed optional dependency so core-only environments such as Homey can use `npm install --omit=optional` without shipping the CLI/MCP graph. Normal npm installs include it; the `cradlewise` executable and `cradlewise/toolcraft` export require Toolcraft to be installed.

```sh
export CRADLEWISE_LOGIN=parent@example.com
export CRADLEWISE_PASSWORD='...'

npx cradlewise list
npx cradlewise status
npx cradlewise status --cradle-id CRIB_ID --output json
npx cradlewise analytics --cradle-id CRIB_ID --start-date 2026-06-01T00:00:00Z --end-date 2026-06-08T00:00:00Z --output json
npx cradlewise refresh-config
```

Run the stdio MCP server with:

```sh
npx cradlewise mcp
```

Or import the command tree:

```ts
import { createSDK } from "toolcraft/sdk";
import { cradlewiseToolcraftRoot } from "cradlewise/toolcraft";

const sdk = createSDK(cradlewiseToolcraftRoot);
const result = await sdk.list({});
```

Toolcraft commands publish explicit crib and analytics output schemas for CLI, SDK, and MCP consumers. Extensible state and event payloads remain JSON-typed because the private service can add fields independently of this package.

Realtime watching is deliberately not exposed as an MCP tool because Toolcraft commands currently model finite request/response operations. The design note proposes lifecycle-aware subscriptions as a Toolcraft improvement.

## Error handling

All package errors extend `CradlewiseError`:

- `CradlewiseConfigError`
- `CradlewiseAuthError`
- `CradlewiseApiError` with `status`, `requestId`, and parsed `responseBody`
- `CradlewiseRealtimeError`

## Security and privacy

- Put credentials in environment variables or a secret manager; never commit `.env`.
- The generated cache contains app configuration, not your account password or session credentials.
- Cache reads reject symlinks, hard links, special files, oversized files, files owned by another user, and control-bearing paths before parsing embedded app secrets. Handle reads remain hard-capped even if a same-user process grows the file after metadata validation, and malformed UTF-8, malformed JSON, or non-object JSON is treated as a cache miss and replaced on the next successful refresh. Concurrent configuration loads for one cache path share a single extraction and atomic write, and temporary cache removal failures are surfaced rather than discarded.
- Child and sleep data is sensitive. Avoid logging raw API responses in shared systems.
- Supported high-level, CLI, and MCP surfaces do not implement state-changing crib controls. The generic client requires an explicit unsafe-method opt-in for independent protocol research.

## Homey app

`packages/homey-app` contains an unofficial Homey SDK v3 app built on the packed SDK. It exposes read-only crib sensors, connectivity, battery and power status, Homey Insights history, Flow conditions and automatic capability triggers, manual refresh, credential repair, and bounded polling on Homey Pro.

The integration is not a safety-critical baby monitor and must not replace the official Cradlewise app.

Use Node.js 24 for the Homey CLI. CI and release verification pin Node.js 24.14.0 for tooling and Node.js 22.22.0 for the shipped Homey runtime:

```sh
npm run homey:install
npm run homey:prepare
npm run homey:verify
```

Prefer `homey:prepare`; it aliases the reference-compatible `homey:install` script. Both only build, vendor, and install the local Homey package dependencies. They do not contact or install the app on a Homey Pro. `homey:verify` is likewise local and non-publishing.

See [`packages/homey-app/DEVELOPMENT.md`](packages/homey-app/DEVELOPMENT.md) for the architecture, capability mapping, live smoke test, and publish workflow.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run test:integration # requires CRADLEWISE_LOGIN and CRADLEWISE_PASSWORD in .env
```

Keep a local `.env` owner-readable only (`chmod 600 .env` on POSIX systems). The package and its reviewed production dependencies do not require install lifecycle scripts.

The integration test verifies configuration cache reuse, authentication reuse, discovery, crib state, connectivity, firmware, sleep events, sleep analytics, status timelines, and nonnegative aggregate values. It performs read-only requests and never prints credentials, tokens, crib IDs, baby IDs, baby names, or raw API payloads.

Coverage gates apply per production file, and production source rejects explicit `any`, unsafe `any` propagation, and non-null assertions at lint time.

`npm run check` also builds the declarations and compiles strict consumers with library checking enabled and `exactOptionalPropertyTypes` both disabled and enabled. This guards both common TypeScript configurations and the `cradlewise/toolcraft` export before packaging.

Both `prepublishOnly` and the release workflow run `npm run release:check`. The check requires an npm lockfile v3, verifies that installed production package versions match `package-lock.json`, rejects production packages that declare install scripts, validates every independently installed production package, and accepts file-based terms only from bounded, nonempty regular LICENSE/COPYING files. CI and release installation use `npm ci --ignore-scripts`, while final pack/publish commands also disable lifecycle scripts. The bundled-internal exception is restricted to the exact reviewed Toolcraft 0.0.87 tarball integrity and child-package set; new versions or bundle members fail closed pending review. Package inspection uses Node's native dotenv parser and checks both local environment values and cached bootstrap identifiers against source files and the exact tar archive. Toolcraft 0.0.87 and Toolcraft Schema 0.0.87 declare MIT terms, so the release gate passes.

Before the first release, create the public `kjopek/cradlewise-js` repository and add an environment-scoped `NPM_TOKEN` granular publish token to bootstrap the unclaimed npm package. After `cradlewise` exists on npm, configure the `release.yml` trusted publisher with publish permission and remove the token secret; subsequent releases use short-lived OIDC credentials. The release job pins npm 11.18.0 and disables dependency caching.

## License

MIT
