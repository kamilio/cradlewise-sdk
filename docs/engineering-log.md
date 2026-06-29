# Engineering log

This is the running record of changes, evidence, findings, unresolved issues, and verification performed while hardening the package. Entries are append-only except for correcting factual errors.

## 2026-07-04 — hardening pass started

### Baseline

- Workspace contains a complete TypeScript package at version 0.1.0.
- Existing gates cover formatting, ESLint, strict TypeScript, Vitest coverage, declaration build, and npm package inspection.
- Existing live integration authenticates with the credentials in the ignored `.env`, discovers one paired crib, and performs read-only state/status/firmware requests without logging identifiers or credentials.
- Existing realtime attempt reaches AWS IoT but the MQTT WebSocket is closed with `AWS_ERROR_MQTT_UNEXPECTED_HANGUP`.

### Initial risk findings

- `CradlewiseRealtime.connect()` does not coalesce concurrent calls and may leak a connection object when connect or subscribe fails.
- A resumed clean MQTT session may require explicit resubscription and a fresh shadow request.
- CLI/package version values can drift because the CLI version is a separate literal.
- Analytics assumes event order and can turn a stale unmatched sleep event into an implausibly long open nap.
- Current tests have strong coverage of stable REST/auth/config code but limited exercised coverage of realtime lifecycle behavior.

### Planned evidence

- Compare the JavaScript realtime handshake with `pycradlewise` using the same account and app config.
- Add fault-injection tests for concurrent authentication, credential expiry, HTTP response variants, realtime connect/subscribe/disconnect failures, and MQTT resume behavior.
- Add package metadata and CLI/MCP contract tests.
- Repeat live read-only integration, full release checks, npm audit, packed-install smoke tests, and credential leakage scans after fixes.

## 2026-07-04 — upstream realtime comparison

### Evidence

- Created an isolated Python 3.12 environment and installed the current `pycradlewise` source plus its AWS IoT dependencies.
- Authenticated with the same ignored `.env`, discovered the same single paired crib, and used the app-extracted IoT endpoint.
- `pycradlewise` failed with the same `AWS_ERROR_MQTT_UNEXPECTED_HANGUP` and reported `mqtt.available == False`.

### Finding

- The realtime handshake failure reproduces in the upstream reference implementation. This strongly indicates an undocumented service/app requirement or account/device policy rather than a JavaScript-only signing or SDK defect.
- The JavaScript implementation must still improve cleanup, concurrency, and resume behavior, but a successful live realtime connection cannot currently be used as a release requirement.

## 2026-07-04 — package consumer analysis

### Evidence

- `publint` 0.3.21 reports no package errors.
- `@arethetypeswrong/cli` reports clean ESM and bundler resolution for the root and Toolcraft subpath.
- It warns that CommonJS `require()` cannot load the ESM package; this is expected for the current ESM-only design and Node 20.12+ engine declaration.

### Finding

- The README needs an explicit ESM-only statement so consumers do not interpret CommonJS incompatibility as accidental.

## 2026-07-04 — realtime lifecycle hardening

### Additional protocol evidence

- Downloaded the current Android XAPK and enumerated every ATS IoT hostname embedded in all DEX files.
- Exactly one IoT endpoint is present, so the handshake failure is not caused by selecting the first of several candidate endpoints.

### Changes

- Coalesced concurrent `connect()` calls so only one credential exchange and MQTT connection can run at a time.
- Made disconnect-during-connect deterministic and added cleanup after connection or subscription failure.
- Added explicit resubscription and shadow refresh after a resumed clean MQTT session.
- Added rollback when a newly added crib subscription fails and added `removeCradle()` for future reconnect scope control.
- Rejected non-object MQTT payloads instead of passing invalid state to callbacks.
- Kept Node's special `error` event safe when no listener is attached.

### Verification

- Replaced two shallow realtime tests with eight mocked connection lifecycle tests.
- Covered concurrent connect, shadow parsing/model merge, interrupted/resumed sessions, dynamic crib subscriptions, connect cleanup/retry, invalid payloads, and disconnect errors.
- Realtime source coverage increased from roughly 33% to 89%; the full suite increased to 26 passing tests and roughly 90% statement coverage.

## 2026-07-04 — current sleep API contract repair

### Critical live finding

- The inherited `eventsV3` request omitted required `start_date` and `end_date` parameters and returned HTTP 400 in the current service.
- The inherited `analyticsV3` request omitted required `start_date`, `end_date`, and `metric_name` parameters and returned HTTP 400 in the current service.
- The current event response is a wrapper containing `events`, `sleep_sessions_saved`, and `timezone`, rather than always a bare event array.
- The current analytics response uses dated `sleep_sessions` and `awake_sessions` arrays whose `value` fields contain minute totals.

### Protocol evidence

- Decompiled the current Android application and confirmed UTC `yyyy-MM-dd HH:mm:ss` formatting, a default seven-day range, and the exact event parameters `start_date`, `end_date`, and `tz`.
- Confirmed analytics parameters `start_date`, `end_date`, `metric_name`, `tz`, `metric_filter`, and `start_hour`.
- Confirmed the application's defaults `metric_name=sleep_metrics`, `metric_filter=app`, an empty `tz`, and `start_hour=8`.
- Queried a sanitized 365-day live range and confirmed sleep/awake values behave as integer minutes.

### Changes

- Added shared date-range resolution and current query defaults to the sleep client methods while retaining the prior numeric `startHour` shorthand.
- Added `getSleepEventsData()` to preserve response metadata and kept `getSleepEvents()` as the event-array convenience method.
- Added aggregation support for the current multi-value metric schema.
- Added CLI date-range options and changed the analytics day default from midnight to the application's 08:00 default.

### Live verification

- Re-ran the repaired current endpoints with the ignored credentials: event and analytics requests both succeeded for the paired crib.
- Received two events in the default seven-day range; only sanitized counts and response-key names were inspected.
- The aggregate returned finite nonnegative values. Zero totals are plausible because the paired crib reported disconnected during this range.

## 2026-07-04 — broader reliability hardening

### Changes and tests

- Added request timeout configuration and wrapped pre-response network failures in the documented `CradlewiseApiError` hierarchy.
- Verified URL/query/body encoding, text and empty responses, and the single authentication retry limit.
- Added concurrent authentication, expiry, retry, and unsupported-challenge tests.
- Corrected existing app-config cache files to mode `0600` when read, not only when first written.
- Centralized package name/version constants and added metadata, CLI, root import, Toolcraft import, and MCP initialize/list smoke tests.
- Documented the package's intentional ESM-only consumer contract.

## 2026-07-04 — release verification pass

### Live verification

- Expanded the credentialed integration script to verify config-cache reuse and in-memory credential reuse.
- Required successful read-only state, online-status, firmware, current sleep-event, current analytics, and status-timeline requests for every discovered crib.
- Required finite nonnegative sleep, awake, soothe, nap-count, and longest-nap aggregates.
- The live test passed for one paired crib and two events in the seven-day range without printing credentials, identifiers, names, or raw payloads.

### Automated verification

- `npm run check` passed with formatting, ESLint, strict TypeScript, 38 tests, declaration build, package/CLI/MCP smoke tests, and npm pack inspection.
- Coverage finished at 90.57% statements, 76.23% branches, 84.82% functions, and 90.57% lines.
- `npm audit --audit-level=moderate` reported zero vulnerabilities.
- `publint` reported no package errors.
- `@arethetypeswrong/cli` passed the declared ESM-only profile for ESM and bundler consumers. Its ignored CommonJS and Node 10 findings are outside the declared Node 20.12+ ESM contract.
- Installed the actual generated tarball into an isolated temporary project and verified the root import, Toolcraft subpath import, and CLI version.
- Scanned the workspace outside ignored `.env`, dependencies, build output, and coverage for the supplied login and password; neither credential was present.

### Dependency review

- Installed versions satisfy all declared ranges and the audit is clean.
- New major versions exist for ESLint, Node types, Vitest, and TypeScript. They were intentionally not mixed into this correctness pass because each carries migration risk and is not required by the supported runtime contract.

### Remaining external limitation

- Live IAM-WebSocket realtime remains unavailable with `AWS_ERROR_MQTT_UNEXPECTED_HANGUP` in both this package and the current Python reference client. Later current-app decompilation established that the service now uses per-device mTLS provisioning instead; REST polling remains the supported fallback.

## 2026-07-04 — silent sleep-data failure prevention

### Finding

- `getSleepEventsData()` treated an unexpected successful response shape as an empty event list.
- `fetchSleepAnalytics()` treated simultaneous event and metric endpoint failures as a valid all-zero aggregate.
- Both behaviors could misrepresent transport or upstream schema failures as genuine no-sleep data.

### Change

- Malformed successful `eventsV3` and `analyticsV3` payloads now raise `CradlewiseApiError` with the response body attached.
- Aggregate analytics still degrades gracefully when either events or metrics succeeds, but raises a package error with both causes when both sources fail.
- Added focused regression tests for malformed payloads and simultaneous endpoint failure.

### Additional historical-range finding

- An unmatched sleep event in a historical query was measured through the current wall-clock time instead of the requested range end, which could inflate fallback nap duration by days or months.
- `fetchSleepAnalytics()` now passes the resolved range end to the aggregator and has regression tests for event-only and metric-only partial success.

### Verification update

- The suite now contains 42 passing tests with 90.76% statement coverage and 80.64% branch coverage in the REST client.
- Re-ran the complete suite under `America/Los_Angeles` and `Asia/Kolkata`; both timezone-variance runs passed unchanged.
- Re-ran the credentialed integration after the stricter response validation and historical-range fix; all current read endpoints still passed.

## 2026-07-04 — realtime removal correctness

### Finding

- `removeCradle()` only removed the identifier from the future reconnect set; active MQTT subscriptions and message callbacks remained registered until disconnect.
- A failed dynamic subscription could also leave topics subscribed if an earlier topic in the same three-topic sequence had succeeded.

### Change

- `removeCradle()` is now asynchronous and unsubscribes all active shadow/state topics immediately.
- If any unsubscribe fails, the realtime client disconnects and reconnects using the reduced crib set so stale callbacks cannot remain active.
- Partial subscription setup now rolls back every topic that succeeded before the failure.
- If that rollback also fails, the client reconnects with the failed addition removed, guaranteeing stale topics are dropped before returning the add error.
- Added mocked lifecycle coverage for successful removal, failed-add rollback, and failed-unsubscribe reconnect recovery.

## 2026-07-04 — credential-window validation

### Finding

- Public negative or non-finite validity windows could make `ensureValid()` accept expired credentials or make realtime refresh scheduling occur after credential expiry.

### Change

- `CradlewiseAuth.ensureValid()` now requires a nonnegative finite minimum-validity window.
- `CradlewiseRealtime` now applies the same invariant to `credentialRefreshWindowMs`.
- Added regression tests proving invalid values fail before authentication or MQTT work begins.
- Added explicit failure-path coverage for incomplete tokens, missing Cognito identity IDs, and partial temporary AWS credentials.

## 2026-07-04 — app-config persistence hardening

### Finding

- Cache refresh wrote directly over the live JSON file, so process termination or disk failure could leave a partially written cache.
- Constructor annotations protected TypeScript callers but JavaScript callers could still pass non-string or whitespace-only required values and a non-string IoT endpoint.

### Change

- Config refresh now writes a uniquely named mode-`0600` temporary file and atomically renames it over the cache, with best-effort temporary cleanup on every path.
- Required and optional string fields now enforce their invariants at runtime.
- Cache tests verify secure mode and that successful writes leave no temporary files behind.
- Added corrupt-cache recovery plus metadata-status, missing-download-URL, missing-base-APK, and missing-Amplify-config fault tests.

## 2026-07-04 — signed-request and query validation

### Findings

- `fetch` followed redirects by default for signed API requests. Redirect behavior is unnecessary for the fixed API endpoint and can risk forwarding nonstandard signed headers to an unintended destination.
- Fractional or excessively large request timeouts pass a simple finite check but are rejected or overflowed by Node's timer implementation.
- Invalid analytics hours and blank metric fields were sent to the service instead of failing locally.

### Changes

- Signed REST requests now use `redirect: "error"`.
- Request timeouts must be positive safe integers within Node's non-overflowing 32-bit timer range.
- Analytics start hour is restricted to integer hours 0–23 and metric name/filter values must be nonblank.
- Toolcraft exposes the same integer minimum/maximum contract in CLI, SDK, and MCP schemas.

## 2026-07-04 — refresh command output minimization

### Finding

- The CLI/SDK `refresh-config` command returned `AppConfig.toJSON()`, including the embedded Cognito app-client secret and identifiers. These values are extractable from the mobile app but do not need to appear in terminal logs or automation output.

### Change

- The command now returns only region, API base URL, and whether realtime configuration was found.
- Added a direct Toolcraft command test that seeds distinctive sensitive values and proves none appear in serialized output.

## 2026-07-04 — malformed core response handling

### Findings

- Malformed profile or crib-list responses were converted into empty arrays, making upstream schema failures indistinguishable from an account with no paired cribs.
- Crib state, online status, firmware, and timeline methods trusted their declared response types without runtime object checks.
- A string-valued `babySleepPhaseV2.eventValue` could escape a getter declared to return a number.

### Changes

- Core discovery and crib read methods now raise `CradlewiseApiError` on unexpected successful response shapes.
- V2 sleep phases now pass through finite numeric normalization before leaving the model.
- Added regression coverage for every affected endpoint and the runtime string phase representation.

## 2026-07-04 — current realtime authentication identified

### Definitive protocol evidence

- Decompiled `RemoteMqttConnectionV2` constructs `AWSIotMqttManager` with the app-assigned device ID as MQTT client ID and calls `connect()` with a locally loaded per-cradle keystore.
- Decompiled `GetDeviceCertificatesUseCaseImpl` obtains certificate material through `POST /cradles/pairedUsers/v3` with account, baby, FCM-token, and device metadata.
- The bootstrap can report maximum-device, registration-incomplete, assignment-failed, access-denied, and user-access-disabled states, confirming it mutates managed device registration rather than serving as a read-only credential exchange.

### Decision and change

- The earlier IAM WebSocket handshake failure is now explained: the current service expects a registered per-device certificate/private key, not the Cognito IAM credentials used by the legacy transport.
- Automatic certificate provisioning is outside this package's read-only safety boundary because it can consume a device slot and alter account state.
- The legacy IAM transport is now disabled by default and requires an explicit `allowLegacyIamAuthentication: true` research opt-in.
- `isRealtimeAvailable()` now accurately reports current-protocol support as unavailable, while `isLegacyRealtimeSdkAvailable()` separately reports optional SDK installation.
- Built-package smoke tests enforce both availability semantics against generated exports.
- README, examples, and design documentation now state that current supported operation is REST polling.

## 2026-07-04 — clean-clone typecheck independence

### Finding

- Repository example files imported the package by its published name, which resolves through `dist` declarations. Local lint/typecheck could therefore pass against stale build output and fail on a clean checkout where `dist` is intentionally ignored.

### Change

- Repository examples now import `../src/index.js`, so lint and typecheck validate the current source tree without depending on generated artifacts.
- A clean-output verification now removes `dist` before running static checks and tests.

## 2026-07-04 — state merge prototype safety

### Finding

- Crib state is populated from API and MQTT JSON. Assigning an own `__proto__` key during recursive merge could change the resulting state object's prototype; `constructor`/`prototype` keys also create confusing object-graph behavior.

### Change

- Initial state and updates now pass through the same recursive merge sanitizer.
- Prototype-altering keys are discarded at every merge depth.
- Added a JSON-parsed malicious-state regression test proving normal nested state still merges and neither the state nor global object prototype is polluted.
- Re-ran all tests with Node's `--disable-proto=throw`; the suite passed without relying on the legacy prototype accessor.

## 2026-07-04 — signed API origin validation

### Finding

- Explicit JavaScript configuration accepted HTTP, malformed, credential-bearing, query-bearing, or fragment-bearing API base URLs. Since requests carry temporary AWS signing headers, accepting an insecure or ambiguous base URL is an avoidable credential-boundary risk.

### Change

- `AppConfig` now requires an HTTPS API URL with no embedded username/password, query string, or fragment.
- Added runtime tests for every rejected URL class while retaining stage/path support and trailing-slash normalization.

## 2026-07-04 — deterministic discovery assembly

### Finding

- Parallel profile-to-crib requests wrote directly into one map as responses completed. If the service returned the same crib under multiple profiles, its associated baby could vary with network timing.
- Arrays with null, primitive, or identifier-free entries passed the outer response-shape check and could fail later or be silently skipped.

### Change

- Profile requests remain parallel, but their results are assembled in the original profile order before updating the public map.
- Profile and crib record elements now require object shape and identifiers before being returned.
- Added delayed-response regression coverage proving first-profile precedence is deterministic even when its request completes last.

## 2026-07-04 — sleep-event element validation

### Finding

- `eventsV3` verified only that `events` was an array. Null or wrongly typed entries could pass the client boundary and then throw inside aggregation or violate the exported `SleepEvent` type.

### Change

- Bare and wrapped event arrays now validate every entry plus known timezone/session metadata.
- Numeric event and soothe values must be finite; optional string fields retain backward-compatible string representations.
- Added malformed-entry regression coverage.

## 2026-07-04 — total crib-status failure handling

### Finding

- `updateCradle()` intentionally tolerates individual state, online-status, or firmware failures, but it also converted simultaneous failure of all three sources into an apparently valid offline crib.

### Change

- Partial status remains available when any source succeeds.
- Simultaneous failure now raises `CradlewiseApiError` with all three causes instead of presenting transport failure as device state.
- Added a three-endpoint failure regression test.

## 2026-07-04 — partial analytics transparency

### Finding

- One-source analytics fallback was useful but indistinguishable from a complete two-source result. Missing events can suppress nap details; missing server metrics can reduce aggregate precision.

### Change

- `SleepAnalytics` now exposes `partial` and `unavailableSources`.
- Event-only and metric-only fallback tests verify the corresponding source marker.
- Dual-source failure still throws rather than returning a partial model with no evidence.

## 2026-07-04 — clean package-smoke linting

### Finding

- The package smoke script intentionally imports generated `dist` modules, but type-aware ESLint treated those imports as unresolved after `npm run clean` and rejected two awaited calls before the build step could run.

### Change

- The generated-module smoke script now has a narrow `no-unsafe-call` lint exemption; all other lint rules remain active, and the script's runtime package, CLI, and MCP assertions still execute after build.

## 2026-07-04 — default install dependency boundary

### Finding

- Installing the packed library also installed the unsupported legacy AWS IoT SDK and its deprecated transitive packages, even though current supported operation is REST-only and `isRealtimeAvailable()` is always false.

### Change

- The legacy SDK is now an optional peer dependency and a development-only dependency for smoke coverage.
- Default consumers no longer download native MQTT bindings or deprecated legacy transitive packages; researchers can install the peer explicitly when testing a verified legacy account.

## 2026-07-04 — publish-stage package linting

### Finding

- `npm publish --dry-run` failed inside `prepublishOnly` because ATTW's `--pack` mode created and then attempted to read a package tarball in npm's active publish staging context.

### Change

- Package type linting now creates a non-dry-run, script-free tarball in an isolated temporary directory, runs ATTW against that exact artifact, and always removes the temporary directory. Explicitly clearing inherited `npm_config_dry_run` is required when the helper runs under `npm publish --dry-run`.
- This preserves the ESM package analysis while avoiding nested publish-stage tarball collisions.

## 2026-07-04 — release verification checkpoint

- Clean-source `format:check`, lint, typecheck, 58-test coverage run, build, package/CLI/MCP smoke, Publint, ATTW, and pack dry-run passed.
- Typecheck, all tests, build, and package smoke passed on Node 20.12.2, 22.22.0, and 24.4.1.
- Five shuffled test seeds, shared-process execution, and Node's `--disable-proto=throw` mode passed.
- `npm ls --all`, `npm audit`, clean-lockfile `npm ci`, default and explicit-legacy tarball installs, and `npm publish --dry-run` passed.
- Live read-only authentication, discovery, state, online status, firmware, events, analytics, timeline, and CLI list/status/analytics checks passed. Live analytics reported both sources available.
- Credential-value and private-key/access-key pattern scans passed; `.env` remains ignored and no package tarball remains in the workspace.

## 2026-07-04 — analytics model constructor safety

### Finding

- `SleepAnalytics` used `Object.assign(this, data)`. A JSON object with an own `__proto__` property could replace the instance prototype, and caller-owned event/source arrays remained aliased into the model and its serialized output.

### Change

- The constructor now assigns only declared fields and defensively copies both arrays.
- Serialization returns fresh event/source arrays so external mutation cannot alter cached model state.
- Added a regression test proving prototype identity and array ownership remain intact.

## 2026-07-04 — analytics metric domain validation

### Finding

- Server analytics accepted any JSON object despite exporting structured metric types, and aggregation trusted negative duration/soothe integers. Malformed arrays could escape the client boundary, while negative metrics could produce impossible negative totals.

### Change

- Known analyticsV3 fields now validate container, date, array, string, and nonnegative finite-number shapes while preserving unknown forward-compatible fields.
- Aggregation ignores negative duration and soothe values and falls back to other valid evidence.
- Added malformed-response and negative-metric regression coverage.

## 2026-07-04 — credential expiration validation

### Finding

- A truthy but nonnumeric JWT `exp` claim produced an invalid `Date` and bypassed the valid `ExpiresIn` fallback. Cognito temporary credentials also accepted an invalid expiration date, causing immediate or repeated authentication churn.

### Change

- JWT expiration claims now require a positive finite number and a representable date; malformed claims fall back to a validated positive `ExpiresIn` or one hour.
- Temporary AWS credentials now require a finite expiration timestamp.
- Added regression tests for malformed JWT claims and invalid AWS credential dates.

## 2026-07-04 — request lifecycle error containment

### Finding

- Circular or otherwise unserializable request bodies threw raw serialization errors outside the package error hierarchy; response-body stream failures also escaped unwrapped. Authorization retries did not cancel the rejected response body before reauthentication, and nonfinite numeric query values were emitted as invalid strings.

### Change

- Body serialization and response-stream failures now raise contextual `CradlewiseApiError` instances.
- First-attempt 401/403 response bodies are canceled before the one allowed authentication retry.
- Numeric query values must be finite.
- Added regression coverage for cancellation, circular bodies, invalid query numbers, and response read failures.

## 2026-07-04 — packaged CLI and MCP validation gates

- Package smoke now verifies exact MCP tool exposure, ensuring the state-changing config refresh command remains absent from MCP.
- It invokes MCP analytics with an out-of-range hour and requires protocol-level argument rejection.
- It also invokes the packaged CLI with marker credentials and invalid input, requiring nonzero validation failure without echoing either secret.

## 2026-07-04 — realtime credential and topic boundaries

### Finding

- Explicit IoT endpoint strings were only checked for nonemptiness, allowing temporary AWS credentials to be used in a signed WebSocket handshake to an unrelated host. Realtime crib IDs also flowed directly into MQTT topic names and could contain wildcards or path separators. The readonly `cradleIds` view exposed the mutable backing set at runtime.

### Change

- IoT endpoints must now be AWS IoT ATS hostnames in the configured Cognito region, both in `AppConfig` and realtime overrides.
- Realtime crib IDs accept only letters, numbers, hyphens, and underscores before any topic construction.
- `cradleIds` returns a defensive snapshot.
- Added endpoint, wildcard, and backing-set mutation regression tests.

## 2026-07-04 — stale realtime callback isolation

### Finding

- MQTT message and connection listeners remained callable after a crib was removed or a connection was replaced. A late message could repopulate removed crib state, and a stale interrupt/resume/error event could alter the current connection lifecycle.

### Change

- Message handlers now require both the originating active connection and current crib membership.
- Connection lifecycle listeners ignore events from replaced connections.
- Subscription and rollback operations are pinned to the connection that initiated them and fail safely if it changes mid-sequence.
- Added a late-message regression after crib removal.

## 2026-07-04 — realtime refresh timer bounds

### Finding

- An invalid or extremely distant credential expiration could create an immediate timer loop or trigger Node's timeout overflow behavior. Timer cleanup and scheduled reconnect behavior lacked direct regression coverage.

### Change

- Realtime credential expiration must be finite, and refresh delays are bounded to Node's maximum safe timer interval with a one-minute floor.
- Fake-timer coverage verifies scheduled reconnect and complete timer removal on disconnect.

## 2026-07-04 — signed REST origin allowlist

### Finding

- API base URLs enforced HTTPS syntax but still accepted arbitrary hosts and ports. Because every request includes temporary AWS signing headers, a mistaken or malicious explicit configuration could disclose credentials outside Cradlewise/AWS infrastructure.

### Change

- Signed REST origins are restricted to `backend.cradlewise.com` or regional API Gateway hostnames matching the configured Cognito region, with custom ports disallowed.
- Existing path/stage support remains intact.
- Added rejection coverage for unrelated hosts, ports, and region-mismatched API Gateway endpoints.

## 2026-07-04 — empty Toolcraft parameter handling

### Finding

- Empty crib IDs were treated as an omitted status filter, and empty analytics date strings were silently dropped by truthiness checks. CLI, SDK, and MCP callers could therefore request behavior different from their explicit input.

### Change

- Crib IDs and date strings now require at least one character in the shared Toolcraft schema.
- Handler branching distinguishes only `undefined` from supplied values.
- Package smoke enforces the MCP schema bounds.

## 2026-07-04 — generic request read-only boundary

### Finding

- The documented generic escape hatch accepted POST, PUT, PATCH, and DELETE by default. This bypassed the package's read-only safety model and could even reach the state-changing device-registration endpoint deliberately excluded from realtime support.

### Change

- Generic requests now permit only GET and HEAD by default and reject other methods before authentication or network access.
- Advanced research use requires explicit `allowStateChangingRequests: true`; high-level and Toolcraft APIs remain read-only.
- Added regression coverage proving blocked methods neither authenticate nor fetch.

## 2026-07-04 — timezone-correct event aggregation

### Finding

- The live eventsV3 contract returns naive local timestamps with microseconds plus an IANA timezone. Aggregation used host-local `Date.parse`, so active nap durations and DST-crossing sessions varied with the machine timezone and could be wrong by an hour or more.

### Change

- `fetchSleepAnalytics()` now preserves the events wrapper and passes its timezone (or the crib timezone fallback) into aggregation.
- Naive timestamps are converted from the declared IANA zone with DST-aware `Intl` calculations; explicit-offset timestamps retain native parsing.
- Invalid timezone/timestamp pairs are excluded rather than interpreted in the host timezone.
- Added a US daylight-saving transition regression proving a two-hour wall-clock interval is one elapsed hour.

## 2026-07-04 — timezone metadata validation

- Crib and events response timezones now require valid IANA identifiers before entering models.
- Caller-supplied sleep query timezones reject invalid identifiers before authentication or network access.
- Malformed timezone metadata now makes the events source fail explicitly instead of silently producing a complete-looking zero aggregate.

## 2026-07-04 — deep model snapshot isolation

### Finding

- Crib state arrays were assigned by reference and object sanitization did not descend into array elements. `Cradle.toJSON()` exposed the live state object, while analytics event copies were shallow, allowing serialized output or original inputs to mutate cached models.

### Change

- JSON-like state and event values now clone recursively while dropping prototype-altering keys inside objects and arrays.
- Both model serializers return deep snapshots for mutable state/event content.
- Added nested-array sanitization and post-serialization mutation regressions.

## 2026-07-04 — release tag/version consistency

### Finding

- The release workflow published on any `v*` tag without proving that the tag matched `package.json`; a mistyped or stale tag could publish an unintended package version.

### Change

- Release now fails before dependency installation unless `GITHUB_REF_NAME` exactly equals `v${package.version}`.

## 2026-07-04 — release note alignment

- All implemented work belongs to the initial unreleased `0.1.0` package, so the changelog now records it under that version rather than implying the shipped tarball predates its own fixes.
- Security wording now distinguishes supported read-only surfaces from the explicitly opted-in generic research escape hatch.

## 2026-07-04 — unsafe request replay prevention

### Finding

- Explicitly opted-in POST/PUT/PATCH/DELETE requests still inherited the automatic one-time 401/403 replay used by read methods. An ambiguous authorization response could therefore duplicate a state change.

### Change

- Automatic credential clearing and replay is now limited to GET and HEAD.
- Added a POST regression proving one fetch attempt and no reauthentication after a 403.

## 2026-07-04 — cache symlink safety

### Finding

- Cache reads followed symbolic links and then chmodded the path. A locally planted symlink could make the library read and permission-change an unrelated file before refresh.

### Change

- Cache files are opened read-only with `O_NOFOLLOW`, parsed and chmodded through the same file handle, and always closed.
- Symlink caches are treated as misses and atomically replaced; a regression proves the target contents and permissions remain unchanged.

## 2026-07-04 — replaced-connection event regression

- Added a two-connection lifecycle test proving late interrupt, error, and disconnect events from the replaced MQTT connection cannot alter current state or reach user listeners, while events from the active connection still do.

## 2026-07-04 — APK bootstrap size limits

### Finding

- Android configuration discovery buffered metadata and the complete XAPK, then synchronously expanded every archive entry without declared or observed size bounds. A compromised mirror response or archive bomb could exhaust memory.

### Change

- Metadata and XAPK bodies are streamed with hard byte limits and early `Content-Length` rejection.
- XAPK extraction selects only base APK candidates and bounds their cumulative declared size; APK extraction selects only Amplify config and DEX files with a cumulative uncompressed limit.
- Added oversized metadata and XAPK response regressions.
- A live refresh confirmed the current metadata and XAPK responses are approximately 93 KB and 81 MB, comfortably below the configured limits.

## 2026-07-04 — identifier and credential input validation

### Finding

- Runtime JavaScript callers could pass blank credentials or malformed crib/baby identifiers; implicit coercion then produced signed paths such as `/null` or empty segments. App configuration also preserved accidental surrounding whitespace.

### Change

- Authentication requires nonempty email/password strings and normalizes email whitespace.
- Every modeled crib/baby path identifier is validated before authentication, and crib models reject blank/space-padded IDs.
- App configuration trims required string fields before sentinel and origin validation.
- Added constructor and pre-network path regression coverage.

## 2026-07-04 — service identifier and event-time validation

- Discovery now rejects blank or space-padded crib IDs as an unexpected API response instead of failing later during model construction.
- Crib records still require string IDs, while numeric baby IDs must be nonnegative safe integers.
- eventsV3 entries require parseable timestamps in the declared response timezone; malformed times make the source explicitly unavailable rather than silently disappearing from a complete-looking aggregate.
- Whitespace-only sleep phase values no longer coerce numerically to the `away` phase.

## 2026-07-04 — final boundary and lifecycle audit

### Findings

- Calendar normalization allowed impossible local timestamps such as February 29 in a non-leap year to become a different valid date.
- Public generic requests accepted malformed method/path values, GET/HEAD bodies, and body values that `JSON.stringify` silently converts to no body.
- A final path-based chmod after atomic cache replacement reintroduced a narrow symlink race.
- A connect request arriving during an in-progress disconnect could resolve while leaving realtime disconnected.
- `ensureValid()` did not prove that newly issued credentials satisfied the caller's requested validity window.
- Toolcraft handlers performed configuration loading and authentication before rejecting several malformed command parameters.

### Changes

- Timestamp parsing now validates calendar and clock components before conversion, including timezone-bearing values.
- Generic requests validate HTTP tokens, nonempty fragment-free paths, method/body compatibility, and representable JSON before authentication or transport.
- Cache replacement relies on the mode-restricted temporary inode and no longer chmods the destination path after rename.
- Realtime disconnect operations are coalesced and connect waits for an active disconnect before establishing a fresh connection.
- Authentication rejects expired tokens/AWS credentials and rejects fresh credentials below the requested remaining-validity threshold.
- Status and analytics command handlers validate identifiers, dates, and date ordering before loading configuration.

## 2026-07-04 — release verification after final audit

- Clean `npm run check` passed with 85 tests and 94.11% statement coverage.
- Node 20.12.2, 22.22.0, and 24.4.0 each passed all tests, the TypeScript build, and package/CLI/MCP smoke tests.
- Four shuffled seeds, shared-process execution, `--disable-proto=throw`, five host timezones including a half-hour DST zone, and twenty repeated realtime runs passed.
- Live integration passed authentication, discovery, state, firmware, events, analytics, and timeline reads; fresh Android config extraction produced a mode-0600 cache.
- Packed default and explicit-legacy consumers, publish dry-run, clean `npm ci`, full and production audits, publint, and ATTW checks passed.

## 2026-07-04 — external dependency licensing blocker

### Finding

- `toolcraft@0.0.84` and its bundled workspace packages publish without license metadata or license files. The current public package therefore must not be released until the Toolcraft project owner supplies an explicit license or this package replaces that dependency with a licensed implementation.

### Evidence

- Registry metadata, installed manifests, the published tarball contents, and the upstream repository tree contain no license declaration for Toolcraft or its bundled internal packages.
- All other direct production dependencies declare MIT or Apache-2.0 licenses.

## 2026-07-04 — CI action supply-chain pinning

- CI and release workflows now pin the current `actions/checkout` and `actions/setup-node` v6 revisions by full commit SHA instead of mutable major tags.
- Dependabot remains configured to propose future GitHub Action revision updates.

## 2026-07-04 — host-independent naive date inputs

- ISO-like timestamps without an explicit offset now use the same UTC interpretation as documented `yyyy-MM-dd HH:mm:ss` inputs.
- Fractional naive timestamps are validated and normalized consistently, eliminating host-timezone-dependent query ranges.

## 2026-07-04 — bounded API response streaming

- Signed API responses now stream through a byte-counting decoder instead of buffering unbounded text.
- The client defaults to a 16 MiB ceiling, rejects oversized `Content-Length` values early, cancels streams that cross the observed limit, and exposes a validated `maxResponseBytes` option.

## 2026-07-04 — APK redirect destination validation

- APKPure metadata requests now reject redirects.
- The required XAPK redirect is followed manually only when it targets the observed `data.winudf.com` HTTPS CDN without credentials or a custom port; further redirects are rejected.

## 2026-07-04 — clean-session resubscription recovery

- A broker resume without a preserved session now reconnects if any required topic cannot be restored.
- The client no longer remains marked connected after a partial or failed clean-session resubscription.

## 2026-07-04 — deterministic disconnect events

- MQTT disconnect callbacks now require the originating connection to remain active, including after all connections have closed.
- Explicit disconnects emit exactly one package-level disconnect event even when concurrent callers coalesce or the SDK later delivers a stale callback.
- A remote disconnect clears the active connection generation immediately, so duplicate callbacks cannot emit duplicate lifecycle events.

## 2026-07-04 — numeric state coercion tightening

- Computed numeric crib properties now accept only finite numbers or nonblank numeric strings.
- Booleans, objects, and whitespace-only strings no longer coerce to misleading zero values.

## 2026-07-04 — computed state getter type safety

- Computed crib getters now verify boolean and string values at runtime instead of returning malformed raw payload values under narrower TypeScript types.
- Raw state remains available for protocol research, while typed convenience accessors return `undefined` on type mismatches.

## 2026-07-04 — immutable signed-host configuration

### Finding

- TypeScript `readonly` fields remained writable to JavaScript callers. Mutating `AppConfig.apiBaseUrl` or replacing an auth reference after construction could bypass the validated host boundary used for signed requests.

### Change

- `AppConfig` instances are frozen after validation.
- Authentication, REST client, and realtime client auth references are nonwritable and nonconfigurable at runtime.

## 2026-07-04 — self-contained package source maps

- JavaScript source maps now embed their TypeScript source content.
- TypeScript does not embed sources in declaration maps, so the small `src` tree is included in the npm tarball to keep every declaration-map target resolvable for editor navigation.

## 2026-07-04 — enforced tarball manifest boundary

- Package lint now verifies required runtime, type, source, documentation, license, and metadata files in the actual tarball.
- Any unexpected top-level path, including tests, scripts, lockfiles, environment files, or local artifacts, fails the release gate.
- Package smoke verifies that JavaScript maps retain embedded source content.

## 2026-07-04 — sleep-phase type alignment

- The exported `CradleState` type now reflects the string-or-number event values accepted from the service and already normalized by the model.

## 2026-07-04 — current crib state and status mapping

### Finding

- Live responses use snake-case summary fields, a camel-case `rawShadow`, `soundSynth` for active audio, `rootfs_version`/`serial_number` firmware fields, and a JSON-encoded online state message. Several convenience getters and update fields therefore remained empty or reported a stale crib as online.

### Change

- Computed getters now resolve current snake-case fields and raw-shadow aliases while retaining legacy field compatibility.
- Audio getters fall back from nullable legacy `music` fields to current `soundSynth` values.
- Firmware updates map `rootfs_version` and `serial_number`.
- Online status parses the current state message and follows the Android client's state-code contract: state `1` is active; other known integer states are not active.
- Live integration now asserts populated current-model booleans, firmware/serial metadata, mode, and setting types after `updateCradle()`.
- Cached state retrieval no longer implies that a crib is online; only a parseable online-status response changes the model's online flag.
- Known online-status and firmware fields are runtime-validated before entering the model.

## 2026-07-04 — APK-backed interval aggregation alignment

### Finding

- The Android client's `calculateSleepAwakeDurations` assigns each interval to the state at its start: event value `4` contributes sleep, value `1` contributes awake, and stirring/away values contribute neither.
- The library previously kept a nap open through stirring and did not derive awake duration when analyticsV3 was unavailable.
- `eventsV3.sleep_sessions_saved`, the app's soothe-session evidence, was discarded by the aggregate fallback.

### Change

- Any non-sleep transition now closes an active nap, while only state `1` accumulates event-derived awake minutes.
- Temporal evidence is clipped to the supplied range end; invalid, untimed, and future events cannot inflate durations or soothe totals.
- `sleep_sessions_saved` now supplies fallback soothe counts, with analyticsV3 counts retaining precedence.
- Noncanonical timestamps no longer fall through to permissive host `Date.parse` behavior.

## 2026-07-04 — nullable API schema and model input hardening

- Current nullable profile, cradle, event, firmware, and analytics fields are accepted and normalized without leaking `null` into required event arrays.
- Metric dates, values, counts, and timezones are validated against the Android model's integer/date contracts.
- Public state updates reject non-plain objects, circular references, and non-JSON object instances; sleep phases require integer values.
- Generic request query/body validation now completes before authentication, avoiding unnecessary credential work for locally invalid requests.

## 2026-07-04 — credential and cache concurrency hardening

- Returned credentials are deep snapshots with independent expiration dates, so caller mutation cannot alter internal auth state.
- Authentication generations prevent a cleared or superseded login from overwriting newer credentials, and stale completion handlers cannot clear a replacement login.
- Cache reads use nonblocking no-follow handles and reject non-regular, oversized, multi-link, or foreign-owned files before parsing.
- The redundant temporary-path chmod was removed; mode `0600` is established atomically at exclusive creation.
- Android bundle discovery prefers `base.apk` and selects only IoT endpoints matching the Cognito region.

## 2026-07-04 — realtime desired-set reconciliation

- The client no longer reports `connected` until initial subscriptions match the current desired crib set.
- Adds/removes during initialization or clean-session recovery are reconciled without duplicate or resurrected subscriptions.
- Duplicate resume callbacks coalesce, interrupted connections are replaced before manual reconnect, and initialization interrupts cannot later report a false connected state.
- MQTT client IDs, credential expiration, UTF-8 payload validity, and a 1 MiB message ceiling are enforced before state delivery.

## 2026-07-04 — release boundary enforcement

- Tarball lint rejects sensitive-looking nested paths, private-key markers, and any local `.env` value appearing in packed content.
- The release workflow now runs `npm run release:check` after the normal package gate and recursively inspects the installed production dependency tree.
- The release check currently and intentionally blocks publication on `toolcraft@0.0.84`, `toolcraft-schema@0.0.84`, and bundled runtime packages that still have neither license metadata nor license files.

## 2026-07-04 — post-hardening verification

- A clean `npm run check` passed 113 tests with 94.29% statement coverage, then passed TypeScript build, CLI/MCP smoke, publint, ATTW, and npm pack validation.
- The actual packed tarball installed into an isolated consumer and loaded its root export, Toolcraft export, and CLI under Node 20.12.2, 22.22.0, and 24.4.0.
- The release-only dependency license check was separately verified to fail specifically on `toolcraft@0.0.84`.

## 2026-07-04 — raw event timestamps are UTC

### Finding

- Decompiled Android conversion code parses raw `eventsV3.event_time` values with a UTC-zone formatter and only then converts them to the selected display timezone.
- `sleep_sessions_saved` timestamps follow the same UTC interpretation.
- The library had incorrectly applied the response/display timezone directly to naive raw values, which could shift instants and distort durations around daylight-saving transitions.

### Change

- Aggregation and endpoint validation now interpret raw naive event and soothe-session timestamps as UTC regardless of display timezone metadata.
- Explicitly offset/zoned timestamps retain their encoded instant.
- `parseEventTime(value, timezone)` remains available for callers that intentionally need local-wall-clock interpretation, but service aggregation no longer uses that mode.

## 2026-07-04 — concurrent REST authorization recovery

### Finding

- Concurrent signed reads could each receive a stale 401/403 and independently start authentication. The authentication client's generation guard correctly prevented stale credential overwrite, but the superseded request could reject instead of sharing the successful refresh.
- A generic request path containing its own query string could be signed ambiguously when combined with `options.query`.

### Change

- Read-only authorization recovery is now coalesced per client. A late failure whose request used an older AWS credential set retries with the already-refreshed credentials instead of authenticating again.
- Rejected response bodies are canceled, credentials are not cleared before refresh, and every read still has a single retry ceiling.
- Generic paths reject embedded query strings, fragments, controls, backslashes, and dot segments before authentication; callers must use `options.query` so the signed URL has one canonical construction path.
- Runtime request options and query values are validated as objects and supported primitive values before any credential work.
- Regression tests cover simultaneous failures, stale late failures, response cancellation, and pre-authentication path rejection.

## 2026-07-04 — archive extraction resource bounds

### Finding

- XAPK extraction limited each preferred `base.apk` entry but did not sum multiple matching entries, so a crafted bundle could exceed the intended decompression budget.
- The embedded Amplify JSON shared a much larger allowance with selected DEX files even though valid configuration is small.
- Runtime configuration-loader options were not fully validated before cache or network work.

### Change

- All preferred base APK entries now share one 512 MiB uncompressed budget, matching the existing fallback-selection behavior.
- Amplify configuration is capped at 1 MiB while selected APK content retains its separate aggregate cap.
- Cache permissions are tightened on the opened file descriptor before parsing, and loader options reject nonobjects, nonfunction fetch implementations, and nonboolean refresh flags.
- Targeted configuration tests pass, including oversized embedded configuration and malformed runtime options.

## 2026-07-04 — Cognito credential normalization

### Finding

- Runtime authentication construction accepted non-`AppConfig` objects and control characters in usernames.
- Cognito token and temporary AWS credential fields were checked only after trimming for emptiness but stored verbatim, allowing whitespace-padded values to reach JWT parsing or SigV4 signing.
- Identity IDs and challenge usernames were not consistently normalized and screened before reuse in subsequent Cognito calls.

### Change

- Authentication requires an options object, a validated `AppConfig` instance, and a nonempty control-free email.
- Token, refresh-token, access-key, secret-key, and session-token strings must be nonempty, already trimmed, and control-free.
- Challenge usernames and identity IDs are normalized once and malformed values fail within the package's authentication error hierarchy.
- Targeted authentication tests pass across constructor, challenge, token, identity, credential, expiry, snapshot, and concurrency cases.

## 2026-07-04 — model ownership and JSON invariants

### Findings

- State cloning rejected circular and custom object instances but still admitted `undefined`, functions, symbols, bigints, and nonfinite numbers, contradicting the exported JSON state contract.
- Full REST state snapshots were assigned directly while realtime updates were defensively cloned and merged.
- Boolean sleep phases were numerically coerced (`true` became phase `1`) despite the public mapper's boolean fallback, and malformed runtime aggregation/model constructor inputs could escape as raw JavaScript errors or invalid typed instances.

### Changes

- Crib state accepts only finite JSON scalars, arrays, and plain objects; unsafe prototype keys remain stripped recursively.
- Added `replaceState()` for owned full snapshots and routed REST state replacement through it, while realtime updates retain deep-merge behavior.
- Crib and analytics constructors validate runtime object shape, typed metadata, nonnegative safe-integer metrics, source names, and owned event arrays.
- Aggregation validates all runtime containers and dates, phase conversion no longer coerces booleans or arbitrary objects, timestamp parsing safely rejects nonstrings, and metric summation rejects unsafe overflow.
- Targeted model, analytics, and client suites pass after the changes.

## 2026-07-04 — Toolcraft direct-handler parity

- Direct SDK handler invocation now rejects nonstring crib IDs and dates through `UserError` instead of leaking raw `.trim()` or date coercion failures.
- Account email controls are rejected before configuration loading, matching the authentication constructor and preventing unnecessary cache/network work.
- Numeric analytics hours retain the same integer 0–23 validation across schema-driven CLI/MCP calls and direct handler calls.
- Targeted Toolcraft command tests pass and continue proving refresh output excludes embedded authentication configuration.

## 2026-07-04 — local publication guard

- The dependency-license gate was present in the tag release workflow but not npm's local publish lifecycle, so a direct `npm publish` could bypass the known Toolcraft license blocker.
- `prepublishOnly` now runs `release:check` before the full package check, making both local and CI publication fail closed until every production dependency carries declared license terms.
- Package metadata regression coverage asserts that both release and quality gates remain wired into `prepublishOnly`.

## 2026-07-04 — realtime constructor security boundary

### Findings

- The legacy IAM opt-in used nullish defaulting without runtime type enforcement, so a truthy string such as `"false"` could enable the unsupported transport.
- Because strings are iterable, passing a single crib ID as `cradleIds` subscribed one topic set per character.
- MQTT client IDs rejected NUL and excess bytes but not other forbidden controls, malformed surrogate sequences, or Unicode noncharacters.

### Changes

- Realtime options must be a plain object with an auth-compatible object, a nonstring iterable of crib IDs, an optional client exposing a crib map, and correctly typed endpoint/callback/opt-in fields.
- The legacy IAM boundary now accepts only literal booleans; malformed truthy values fail before credentials or SDK loading.
- Credential refresh windows require nonnegative safe-integer milliseconds.
- MQTT client IDs enforce the 128-byte limit and valid MQTT UTF-8 exclusions across C0/C1 controls, lone surrogates, and Unicode noncharacters.
- All 26 realtime lifecycle and fault-injection tests pass after the hardening.

## 2026-07-04 — root export reconciliation

- Documentation described `parseEventTime(value, timezone)` as callable, but the package root did not export it and no supported subpath exposed `analytics.ts`.
- The strict timestamp parser is now exported from the root, exercised by the built-package smoke test, and documented alongside UTC service-timestamp semantics.
- Release documentation now reflects that the transitive production-license gate runs during both local npm publication and the tag workflow.

## 2026-07-04 — refreshed full verification

- A clean `npm run check` now passes 119 tests with 94.60% statement/line coverage, 90.67% branch coverage, and 94.08% function coverage.
- TypeScript build, root/Toolcraft imports, CLI, MCP, publint, ATTW, source-map content, secret scanning, and dry-run tarball checks all pass.
- The actual packed tarball installs into an isolated consumer and passes root model/parser plus Toolcraft imports under Node 20.12.2, 22.22.0, and 24.4.0.
- Full and production-only clean lockfile installs pass, both npm audit modes report zero vulnerabilities, and production installation emits no deprecation warnings.
- Four shuffled suite seeds, `--disable-proto=throw`, five timezone environments, and 20 consecutive realtime suite runs pass.
- `npm run release:check` and `npm publish --dry-run` both fail before publication on the known unlicensed Toolcraft runtime packages, confirming the release boundary cannot be bypassed through npm's local lifecycle.

## 2026-07-04 — refreshed live read-only verification

- The integration workflow passed configuration cache reuse, authentication and credential snapshot reuse, discovery, typed state, online status, firmware, events, analytics, and status timeline reads for the paired account without printing identifiers or payloads.
- The built CLI passed live `list`, `status`, and `analytics` commands with output held in mode-restricted temporary files, structurally validated, and deleted without terminal disclosure.
- A forced Android bundle extraction passed against the current published artifact and wrote a mode-0600 cache.
- Eighteen parallel signed state/online/firmware reads passed with one shared authentication client, exercising concurrent credential reuse against the live service.

## 2026-07-04 — cross-platform cache identity checks

### Finding

- Cache symlink defense relied on `O_NOFOLLOW`, which is not available on every Node-supported platform. Where absent, opening first could follow a link before file-type checks.

### Change

- Cache reads now lstat the path before opening, reject unsafe metadata up front, and require the opened descriptor's device/inode identity to match the original path metadata.
- Descriptor checks still enforce regular-file type, one link, size, and current-user ownership before permissions are tightened and JSON is parsed.
- The live integration assertions now verify the credential set is actually reused without printing values, include soothe-session evidence in direct aggregation, and require all aggregate metrics to be nonnegative safe integers.
- Targeted cache tests, type checking, linting, and formatting pass.

## 2026-07-04 — REST unsafe-method opt-in validation

### Finding

- `allowStateChangingRequests` used nullish defaulting without runtime type enforcement, so a truthy string such as `"false"` could disable the client's read-only boundary.
- Malformed fetch and user-agent options were deferred until signing/transport, and a missing auth object failed outside a clear constructor contract.

### Change

- The client now requires an auth-compatible object and a runtime options object before assigning immutable state.
- Fetch must be callable, custom user agents must be nonempty and control-free, and the state-changing opt-in accepts only literal booleans.
- Regression coverage proves malformed construction fails immediately and cannot accidentally enable POST/DELETE behavior.

## 2026-07-04 — configuration object and URL canonicalization

- `AppConfig` now rejects nonobject constructor input and control characters in every required string before Cognito or URL consumers can see them.
- Trusted API URLs are stored in canonical origin/path form, removing default-port/trailing-slash ambiguity and normalizing dot segments before signed request concatenation.
- Existing hostname, regional API Gateway, HTTPS, credential, query, fragment, and IoT endpoint restrictions remain enforced.
- Configuration tests now cover malformed objects, control-bearing identifiers, and canonical path normalization; all 14 targeted tests pass.

## 2026-07-04 — strict public date grammar

### Finding

- Public sleep-range formatting fell through to JavaScript's permissive `new Date(string)` parser for non-naive inputs. Locale-style strings such as `01/02/2026` could therefore be accepted differently across runtimes or hosts despite the documented ISO/UTC contract.

### Change

- String dates now accept only strict calendar dates or the package's canonical timestamp grammar with an optional explicit UTC offset.
- Date-only values are validated as midnight UTC, invalid leap days fail, offsets normalize to UTC, and nonstring runtime values fail consistently.
- Toolcraft direct handlers inherit the same grammar and reject locale-formatted dates before configuration or authentication.
- Targeted client and Toolcraft tests pass.

## 2026-07-04 — Android duration rounding alignment

### Finding

- Decompiled `calculateSleepAwakeDurations` accumulates sleep and awake elapsed milliseconds across all intervals, then uses `Math.round(totalMs / 60000.0)`.
- The fallback implementation floored each awake interval and each nap independently. Repeated sub-minute events or multiple short naps could therefore undercount a combined minute as zero.

### Change

- Event-derived sleep and awake totals now accumulate milliseconds first and round once after all chronological intervals, matching the Android calculation.
- Nap boundaries remain available for count/start/end metadata, and longest-nap duration uses the same nearest-minute rounding convention.
- Added a regression with repeated 30-second awake events and two 20-second naps proving combined elapsed time is retained.
- All 16 analytics tests and 35 client tests pass.

## 2026-07-04 — canonical request option containers

- Client construction, generic request options, and query maps now require plain objects rather than accepting arbitrary class instances with silently ignored properties.
- Null-prototype maps remain supported; arrays, dates, and other object instances fail before authentication.
- Targeted client tests continue to pass across constructor, request, response, retry, analytics, and safety-boundary cases.

## 2026-07-04 — Cognito SDK client cleanup

- Each authentication attempt now destroys both AWS SDK clients in a `finally` path, including challenge, token, identity, and credential failures.
- Cleanup failures are contained so they cannot replace a successful credential result or the original authentication error.
- Authentication tests verify provider cleanup on early challenge failure and both provider/identity cleanup after a complete exchange.

## 2026-07-04 — bounded model-state recursion

- State cloning now rejects sparse arrays instead of silently preserving holes that JSON would reinterpret as `null`.
- Crib/event JSON ownership is capped at 100 nested levels, producing a controlled `TypeError` before recursive cloning or deep merging can overflow the JavaScript stack.
- Circular-reference, nonfinite scalar, custom-object, prototype-key, sparse-array, and excessive-depth regressions all pass with the broader model/client/analytics suites.

## 2026-07-04 — APK mirror trust-boundary reduction

### Finding

- Automatic configuration discovery downloads the public Android bundle from a third-party mirror. Although `AppConfig` restricted endpoints to trusted AWS/Cradlewise host patterns, a substituted bundle could still choose another allowed region or API Gateway hostname.

### Change

- Auto-discovered configuration is now pinned to the known `us-east-1` region and `backend.cradlewise.com` service hostname before any values are cached or used.
- Cached auto-discovery values must satisfy the same pin; older or manually altered API Gateway entries are ignored and refreshed.
- Explicit `AppConfig` construction retains regional API Gateway support for independently verified migrations and research.
- A crafted mirrored bundle pointing at an otherwise valid regional API Gateway hostname is rejected in the configuration fault-injection suite.
- Documentation now recommends explicit configuration for production use that wants to remove the mirror/bootstrap dependency entirely.

## 2026-07-04 — Toolcraft license blocker resolved

### Evidence

- npm now publishes `toolcraft@0.0.87` and `toolcraft-schema@0.0.87` with `license: "MIT"`; the Toolcraft tarball includes a root MIT license covering the shipped package.
- Toolcraft's internal workspace packages are marked `private: true` and `inBundle: true` in the consumer lockfile. They are shipped as part of the licensed parent tarball rather than independently resolved npm dependencies.

### Change

- Upgraded Toolcraft from 0.0.84 to 0.0.87.
- The release checker continues to validate every independent production package and now skips npm `inBundle` entries after their enclosing parent package has been validated separately.
- In an isolated repository copy, the revised license gate passed and the full 122-test/build/CLI/MCP/publint/ATTW/pack suite passed unchanged with Toolcraft 0.0.87.
- The previous publication blocker is resolved; current local `npm run release:check` passes.
- The bundled-package exception is constrained: an `inBundle` entry is skipped only when its nearest npm parent explicitly lists that package in `bundleDependencies`/`bundledDependencies` and the parent independently passes the license check.
- Fixture tests prove licensed declared bundles pass while independent and undeclared unlicensed packages fail.

## 2026-07-04 — post-upgrade release and live verification

- The upgraded main workspace passes 122 tests with 94.58% statement/line coverage, then passes build, root/Toolcraft loading, CLI, MCP, publint, ATTW, secret scanning, and npm pack checks.
- `npm run release:check` and the full `npm publish --dry-run` lifecycle both pass with Toolcraft 0.0.87.
- The actual packed consumer passes on Node 20.12.2, 22.22.0, and 24.4.0.
- Both full and production npm audits report zero vulnerabilities; all runtime dependencies are at their current allowed/latest versions.
- Live integration passes with safe credential-set reuse assertions and rounded analytics. Fresh pinned Android extraction plus built Toolcraft 0.0.87 CLI `list`, `status`, and `analytics` workflows also pass without terminal disclosure of private data.

## 2026-07-04 — public realtime and helper surface alignment

- `CradlewiseRealtimeOptions.cradleIds` now excludes primitive strings at compile time, matching the runtime requirement for a nonstring iterable and preventing character-by-character topic subscriptions in TypeScript callers.
- The realtime example now fails early with the current certificate-provisioning limitation instead of enabling the incompatible legacy IAM transport, and it no longer prints raw state payloads.
- `isAwsIotEndpointForRegion` is exported from the package root, exercised by the built-package smoke test, and safely returns `false` for malformed JavaScript inputs.
- Targeted configuration/realtime tests, build, and CLI/MCP package smoke pass.

## 2026-07-04 — continuous license enforcement

- Normal pull-request/push CI now runs the production dependency license check on every supported Node version before the broader package gate.
- Contributor guidance includes the same release check, preventing future dependency changes from reintroducing ambiguous publication terms unnoticed until tagging.

## 2026-07-04 — live MCP verification

- A built Toolcraft 0.0.87 MCP server completed initialization and a valid live `cradlewise__list` tool call against the paired account.
- The response was validated structurally in memory, never printed, and the MCP child process was terminated after the result.

## 2026-07-04 — precise license-term validation

- The release gate no longer treats a `NOTICE` attribution file by itself as redistribution permission.
- A package now passes through a declared non-placeholder license, a root LICENSE/COPYING file, or a nonempty exact root file named by `SEE LICENSE IN ...`.
- Path-bearing/missing license references and `UNLICENSED`, `UNKNOWN`, or `NONE` placeholders fail closed.
- Fixture tests cover SPDX-style declarations, exact referenced terms, licensed bundled internals, notice-only packages, undeclared bundles, and independent unlicensed packages.

## 2026-07-04 — consumer mode expansion

- The isolated installed tarball now also passes CommonJS `await import("cradlewise")` and `await import("cradlewise/toolcraft")` under Node 20.12.2, 22.22.0, and 24.4.0.
- The npm-created `node_modules/.bin/cradlewise` executable reports the expected package version.

## 2026-07-04 — npm signature audit limitation

- `npm audit signatures` stops on Toolcraft's private bundled workspace package names because those `inBundle` entries intentionally have no independent npm registry records.
- The independently published `toolcraft@0.0.87` and `toolcraft-schema@0.0.87` registry metadata both include npm signatures and SHA-512 integrity values; lockfile installation also verifies their parent tarball integrity.
- This is an npm CLI limitation for bundled private entries, not a vulnerability or missing signature on the published parent packages.

## 2026-07-04 — encoded path and public input hardening

- Generic REST paths now reject percent-encoded dot segments, encoded separators/controls, and malformed percent escapes before credentials are loaded.
- High-level baby/crib identifiers reject path separators, dot segments, and control characters at the client boundary; crib models and Toolcraft commands enforce the corresponding crib-ID invariant.
- Sleep range, timezone, start-hour, and metric query options now reject non-object, nullable, mistyped, padded, and control-bearing inputs before authentication.
- WHATWG URL normalization fuzzing covered literal, mixed, and encoded dot variants without finding a remaining normalization bypass.

## 2026-07-04 — bounded bundle spooling and response cleanup

- Failed APKPure metadata and XAPK status responses now cancel their bodies before raising discovery errors.
- Response bodies larger than 8 MiB spool into random mode-0600 temporary directories instead of retaining all chunks plus a second contiguous heap copy.
- Success and injected stream-failure tests cross the spill threshold and prove temporary download directories are removed in both paths.

## 2026-07-04 — credential and realtime race closure

- Token validity now uses the earliest verifiable Cognito access-token, ID-token, and reported expiration rather than considering only the ID token.
- Realtime add/remove overlap detection reconnects after a late unsubscribe could otherwise erase a concurrently re-added crib's subscriptions.
- Lifecycle intent generations prevent an older scheduled reconnect from bringing the connection back after a newer explicit disconnect.

## 2026-07-04 — release and serialization precision

- The release gate now verifies installed production versions against `package-lock.json` and requires file-based license terms to be bounded, nonempty regular files; empty and symlinked LICENSE fixtures fail closed.
- Model JSON serialization uses definedness rather than truthiness, preserving accepted empty optional strings and complete round-trips.
- The documented Toolcraft SDK command surface is instantiated in unit tests, while packed ESM, CommonJS dynamic-import, and CLI consumers pass on Node 20.12.2, 22.22.0, and 24.4.0.

## 2026-07-04 — final extended verification checkpoint

- The clean package gate passes 135 tests with 94.76% statement/line, 91.3% branch, and 94.44% function coverage, followed by build, root/Toolcraft/CLI/MCP smoke, publint, ATTW, secret scanning, pack inspection, release checks, and the complete npm publish dry-run lifecycle.
- Five shuffled full-suite seeds pass with prototype mutation disabled and unhandled rejections strict; UTC, Chicago, New York, Kolkata, Lord Howe, and Chatham timezone runs pass; 30 repeated realtime race suites pass.
- Read-only live integration passes configuration/authentication reuse, discovery, state, connectivity, firmware, events, analytics, and timeline checks. Fresh pinned Android extraction/cache reuse plus built Toolcraft CLI list/status/analytics and a valid MCP list call also pass without printing identifiers or payloads.

## 2026-07-04 — complete bootstrap trust fingerprinting

### Finding

- Region and backend-host pinning alone did not prevent a substituted Android bundle from supplying attacker-controlled Cognito user-pool, app-client, secret, or identity-pool identifiers in the same AWS region. Authentication could therefore be directed at the wrong Cognito tenant even though REST signing remained host-restricted.
- A substituted same-region AWS IoT ATS endpoint could also survive discovery or cache validation independently of the trusted authentication configuration.

### Change

- Auto-discovery now compares a SHA-256 fingerprint of the verified Cognito user pool, app client, app client secret, identity pool, region, and complete API base URL before the configuration can be cached or used.
- The discovered IoT endpoint has an independent verified fingerprint. Untrusted extracted endpoints are dropped, and caches containing an untrusted endpoint are refreshed.
- Only non-reversible fingerprints are committed; no raw discovered identifiers or app-client secret were added to source or tests.
- Fresh public Android extraction and the full read-only live authentication workflow pass through the production fingerprint checks. Legitimate upstream rotations intentionally fail closed until the package fingerprint is updated or the caller supplies an independently verified explicit `AppConfig`.

## 2026-07-04 — reviewed bundle exception pinning

- A generic `bundleDependencies` declaration plus parent LICENSE is not sufficient evidence that every future bundled child is covered by the same terms.
- The release gate's bundled-package exception is now restricted to the reviewed `toolcraft@0.0.87` SHA-512 tarball integrity and its exact eleven bundled workspace package names.
- A Toolcraft version, archive-integrity, or bundle-membership change fails closed until reviewed; a fixture proves the same package/version with an unreviewed archive integrity no longer exempts its private child.

## 2026-07-04 — final release hygiene hardening

- Cross-platform cleanup replaces the shell-specific `rm -rf`; every build removes `dist` first so deleted modules cannot survive into a local publish.
- New cache directories are created owner-only (`0700`) while cache files remain `0600`.
- Tarball content scanning now rejects common AWS access-key, npm token, and GitHub token formats in addition to private-key blocks and exact local `.env` values.
- The release workflow runs the production installation/license gate immediately after `npm ci`, before build and package checks. The npm `cradlewise` name is currently unclaimed, and a generated CycloneDX SBOM represents all 63 independent production packages.
- Authenticated GitHub lookup confirmed that `kjopek/cradlewise-js` does not yet exist. The intended repository metadata remains because npm provenance requires a matching public repository; the release workflow now rejects any other GitHub repository identity, and the repository must be created before release.
- The release job pins npm 11.18.0 on Node 24 because npm trusted publishing requires npm 11.5.1+ and Node 22.14+. OIDC publishing also requires the npm trusted-publisher relationship to be configured before the tag workflow runs.
- npm trusted-publisher configuration requires the package to exist first. The release publish step therefore accepts an environment-scoped `NPM_TOKEN` granular token for the initial bootstrap; after the package exists and `release.yml` is registered as its trusted publisher, the token should be removed and npm will use OIDC. Release dependency caching is disabled.
- Release checkout fetches complete history and verifies that the tagged commit is an ancestor of `origin/main`, preventing a matching version tag on an unmerged side branch from publishing.
- After all gates pass, release packs once, prints the tarball SHA-256, and publishes that exact archive. The final publish command therefore cannot rebuild a different artifact between verification and upload.

## 2026-07-04 — final boundary and race audit

- Generic query validation now rejects prototype-sensitive names before Smithy canonicalization; the regression specifically covers an own `__proto__` query property.
- `ensureValid()` now carries an authentication generation across its post-login validity check, so `clearCredentials()` cannot land between shared login completion and return a credential set that was explicitly invalidated. Forty repeated authentication/realtime race runs pass.
- Cache files are read through a fixed `MAX_CACHE_BYTES + 1` handle buffer after inode/ownership validation, preventing a same-user append race from turning the cache read into an unbounded allocation. Control-bearing cache paths are rejected before I/O.
- The cleanup helper now accepts only safe local tarball basenames, closing Windows drive-relative paths such as `C:file.tgz`; positive and negative cleanup tests pass.
- Production lint now rejects explicit `any`, unsafe assignment/argument/member/return propagation, and non-null assertions. Coverage thresholds apply per production file at 85% statements/lines, 80% branches, and 80% functions.
- Package leak inspection uses Node's native dotenv parser and compares packed files plus raw tar bytes against local environment secrets and cached Cognito/IoT bootstrap values. `SECURITY.md` is required in the published artifact.
- The clean gate passes 152 tests with 94.58% statement/line, 90.59% branch, and 94.65% function coverage, followed by build, CLI/MCP smoke, publint, ATTW, secret scanning, exact-tar license checks, byte-reproducible packing, and exact-tar publish dry-run.
- Installed ESM and CLI consumers pass on Node 20.12.2, 22.22.0, and 24.4.0. Fresh pinned Android extraction, full read-only live integration, built CLI list/status/analytics, and a live MCP list call pass without printing identifiers or payloads.

## 2026-07-04 — declaration, deadline, and payload hardening checkpoint

- Fixed a strict-consumer declaration incompatibility by allowing undefined indexed JSON properties, added exported `CradleData`, realtime event-map, and API error-option types, and made `npm run check` compile a DOM-free Node consumer with library checking enabled and `exactOptionalPropertyTypes` disabled.
- Added explicit Toolcraft crib and analytics output schemas; packed CLI/MCP smoke now closes stdin deterministically and validates those schemas without exposing configured secrets.
- Shared one hard REST deadline across the initial request and its single authorization retry. Response cancellation, bootstrap cancellation, and stream cleanup are best-effort and no longer await untrusted promises that can hang an error path.
- Bounded passwords, challenge sessions, AWS credentials, app-config strings, cache paths, serialized request bodies, discovery cardinality/fanout, Toolcraft status fanout, realtime crib IDs, and parsed JSON depth/value counts before expensive or fanout-heavy work.
- Realtime now rejects invalid or insufficiently valid credentials before constructing the MQTT SDK provider and validates every payload independently of whether a client model cache is attached.
- Public model serialization revalidates mutable fields, analytics snapshots its baby identifier and timezone for the lifetime of a request, and JSON responses reject non-finite values before endpoint-specific parsing.
- Archive extraction verifies actual decompressed byte counts in addition to archive metadata, while cleanup refuses to recursively remove directories whose names merely end in `.tgz`.
- The current suite passes 209 tests with 94.13% statement/line, 91.01% branch, and 96.23% function coverage. Node 20.12.2, 22.22.0, and 24.4.0 each pass typecheck, tests, build, declaration smoke, CLI smoke, and MCP smoke; three shuffled seeds also pass.
- Production and full npm audits report zero vulnerabilities; the production graph is valid, with Toolcraft intentionally retained at the documented 0.0.87 integration surface. Publint, ATTW, license/install verification, optional-dependency-free packed installation, strict packed declaration consumption, source-map path inspection, and byte-reproducible packing pass. The checkpoint tarball SHA-256 is `d0b1780f6c0c7fc23dbee48f324f4cacfc1ddeb1bd0f48511c0d57e1e3830d26`.

## 2026-07-04 — Homey app checkpoint

- Added a Compose-first Homey SDK v3 local app in `packages/homey-app`, following the lifecycle and validation pattern used by the Hatch Sleep Homey package while preserving Cradlewise's intentionally read-only service boundary.
- Pairing and repair use stable crib IDs, scoped clients, generation-safe login state, serialized repair attempts, and rollback of stored credentials after a failed reconnect. Device instances serialize reconnect, refresh, settings, and deletion work; polling is coalesced and preserves the prior timer if replacement fails.
- Homey exposes baby presence, needs-attention, sleep phase, soothing, bouncing, sound, light, battery, power, mode, and percentage status. Malformed optional values are skipped, display strings are bounded and sanitized, and custom capabilities supply automatic Homey change triggers alongside explicit presence, attention, sleep, soothing, and refresh Flow cards.
- Added original Cradlewise-themed store and device assets, Homey-specific user/developer documentation, a Node 24 runtime gate, transactional SDK tarball vendoring, generated-manifest drift detection, and a built-runtime smoke test that loads the copied production dependency graph.
- Corrected the deployment boundary after checking the current Homey runtime table: Homey v12.9.0+ runs apps on Node.js 22, while Node.js 24 is required only by the current local CLI dependency graph. The manifest now requires Homey v12.9.0, the shipped package accepts Node.js 22, and development build/validation remains pinned to Node.js 24.
- Initially routed SDK configuration caching to `/userdata`, then removed that design after confirming Homey exposes the mount over its web interface. The final integration reconstructs validated `AppConfig` values from private ManagerSettings and uses `/tmp` only for bounded bootstrap archives.
- The Homey suite passes all 257 tests at 100% line, 97.61% branch, and 100% function coverage on both the Node 24 development toolchain and Node 22 runtime line. Enforced package thresholds are 100% lines, 95% branches, and 95% functions, with a metadata regression test preventing silent weakening. Homey's `publish` validation passes; `verified` validation is blocked only by the intentionally absent public support destination. The production build contains the vendored SDK and reports zero production and full npm audit findings.
- Artifact file and directory descriptors now close through one tested lifecycle helper. If inspection and close both fail, an `AggregateError` retains the original safety violation first and the close failure as its cause; if inspection succeeds, a close failure still fails the gate.
- Capability rollback fixtures now model Homey's documented `null` result for unknown values. A failed first publication restores that unknown state instead of retaining a partial candidate observation, while malformed `undefined` responses remain contained without attempting an invalid restoration.
- Reviewed availability-message and sleep-phase membership now use captured Set intrinsics, with prototype-tampering probes proving normalization remains deterministic.
- Remaining Homey-boundary Array append/map/slice and Set membership/add operations now use captured intrinsics. Validated credentials are frozen before client creation or pairing retention, preventing adapters from mutating the session snapshot.
- Descriptor-backed directory tests now cover both pathname replacement and in-place entry mutation during inspection.
- Staging removes JavaScript source maps plus `.npmignore` packaging metadata, vendored SDK sources, engineering docs, package README/changelog/security prose backed by separate license files, exact-integrity-reviewed development files, development-only SDK package metadata, optional CLI/Toolcraft/type-shim entry files, and empty directories after full preflight. The runtime shrank from 1,424 files and 5,568,497 bytes to 1,301 files and 4,394,845 bytes while retaining 35 license/notice files and successful core runtime loading.
- The current reviewed build reproducibly hashes to SHA-256 `719a44635fa9c2a8e9c565992f9e88e9543948787d55392d213b89c2e0fe6361` across 1,301 files and 4,394,845 bytes. Stage, exact archive, private-snapshot, clean-install, clean-source, and final Node 22 evidence was rerun after the final source freeze.
- Contact-free launcher orchestration fixtures prove the private snapshot remains available until a remote run or child process settles, install passes the selected Homey and `skipBuild` to the app bound to that same path, termination signals reach the child, listeners are removed afterward, cleanup follows both success and failure, and an `AggregateError` retains simultaneous runtime and cleanup failures. Device contact now occurs only in that child, allowing the parent to remove the snapshot even when Homey CLI terminates itself; the CLI's implicit zero-code installation abort is converted into a failure.
- CI and tagged release now invoke a dedicated contact-free prepared-stage verifier after publication. It creates the same private execution snapshot, independently repeats reviewed-build equality, smoke, digest, and pinned-CLI archive checks, preserves simultaneous verification/cleanup failures, and removes the snapshot before any Homey API lookup. The published local stage and private verifier both reproduce SHA-256 `719a44635fa9c2a8e9c565992f9e88e9543948787d55392d213b89c2e0fe6361` across 1,301 files and 4,394,845 bytes.
- The normal local `homey:stage` command now chains `homey:stage:verify` after publication as well, so local, CI, and tagged-release staging all finish with the same child-equivalent private-snapshot check without device contact.
- Generated store metadata now explicitly describes the app as an unofficial read-only integration, and a manifest regression assertion prevents that attribution from disappearing.
- Visual QA covered full-size and small store/device PNGs plus a 512 px rasterization of the launcher SVG. The moon was raised above the crib rail to remove silhouette overlap while preserving the established purple/cream artwork language.
- UX copy review clarified the repair title, account e-mail/password labels, and formatted manual-refresh action. Manifest tests lock the revised attribution and account wording.
- A source-level data-minimization regression now prevents the Homey runtime from introducing baby profile identifiers, timezone persistence, device store writes, console output, or direct logger calls outside the contained dispatchers.
- Established-device refresh keeps its capability rollback token until live crib identity, lifecycle state, and Homey availability all commit. Late availability errors, partial availability writes, synchronous deletion side effects, and deletion during an awaited availability write restore prior sensor/availability state; the failure counter resets only after the complete transaction succeeds.
- Capability publication now journals each intended write before awaiting Homey. If Homey applies a capability and then rejects the write promise, rollback observes the applied value and restores the prior value instead of leaving a partial transaction.
- The CommonJS SDK boundary now requires `AppConfig`, authentication/client constructors, configuration discovery, and trust verification to be own data-property functions. Inherited/accessor-backed exports fail before authentication, and a client-constructor failure clears the already-created authentication credentials without masking the constructor error.
- Homey artifact scanning additionally rejects `.git`, `.ssh`, `.aws`, and `.gnupg` directories, common private-key filenames, and GitLab, Slack, Google API, and Stripe live-secret signatures while retaining explicit near-miss fixtures.
- Before any deletion, pruning now plans safety and mode normalization across the complete app tree, so an app-level link, special file, or hard link cannot be discovered only after optional packages are gone. Surviving entries are reopened without following links, checked against their planned device/inode/type, and normalized to `0644` regular files or `0755` directories; smoke tests reject later mode drift.
- Isolated staging validates both the reviewed input and copied snapshot. App source trees must be link-free, while npm's expected executable links are accepted only when relative, contained by the copied `node_modules` tree, non-dangling, and resolved to a single-link regular file rather than a directory alias or cycle.
- The dedicated Homey CI job and tagged-release job now prepare an isolated stage under `RUNNER_TEMP`, forcing the same pinned-CLI archive extraction and exact digest comparison used by the local operator workflow without contacting a Homey.
- Stage publication now treats the artifact directory and mode-`0600` verification record as one transaction. Existing entries are safety-checked and backed up inside a private random transaction directory, temporary and published device/inode/type/mode identities must match, the published tree is re-digested, the record bytes are compared exactly, and partial publication or post-rename drift restores the prior pair while preserving both primary and rollback failures.
- Guarded stage reads now reuse the staging serializer and require the record's exact canonical bytes. Valid JSON with extra fields or reordered keys therefore fails just like malformed UTF-8, linked records, permission drift, or digest mismatch.
- Build, archive, staging, and guarded-contact paths now hash the installed `homey@4.3.1` package before loading its runtime modules. The lockfile test also pins the exact registry URL and SRI. The reviewed package contains 108 files and 761,815 bytes with SHA-256 `9cff4f161bc3e12916f48adec9a65ed5c19f4cdbe34e9900b1528e291053713f`; an isolated copied-package mutation fixture proves drift fails closed.
- Independently packing `homey@4.3.1` from the registry and extracting its `package/` tree reproduces the same 108-file, 761,815-byte full-tree digest, confirming the trust anchor describes the pinned archive contents rather than local installation residue.
- Exact CLI archive extraction rejects paths above 4,096 UTF-8 bytes or components above 255 bytes in addition to traversal, separators, controls, bidirectional formatting, duplicate-file collisions, unsupported entry types, and total entry/byte ceilings.
- A final clean-source verification copied the repository without either dependency tree, generated SDK archive, `dist`, `.homeybuild`, coverage output, or local environment files, ran fresh root `npm ci --ignore-scripts`, and completed the full 257-test `homey:verify` workflow. It reproduced the same 1,301-file artifact as the final local stage.
- The local `homey:install`/`homey:prepare` dependency step now uses `--ignore-scripts`, matching `homey:verify` and the successful clean-source reproduction instead of allowing unnecessary third-party lifecycle execution during setup.
- SDK vendoring is now import-safe and directly fixture-tested. An exclusive mode-`0600` workspace lock serializes packing, tarball/lockfile replacement, installation, and rollback while retaining combined operation/cleanup failures. Temporary workspace and tarball cleanup also preserve the primary vendoring failure rather than masking it. Tarball discovery accepts only bounded semantic-version names, rejects archives above 16 MiB, and replacement copies into a random `COPYFILE_EXCL` transaction path so a precreated symlink cannot redirect writes; concurrency rejection, normal replacement, and sentinel preservation all pass.
- Homey `verify:runtime` now verifies the local vendor filename/version binding, package and lockfile references, archive SHA-512 integrity, installed package identity, exact core `.js` membership, and byte equality against the root `dist` before the CLI can preprocess the app. An isolated fixture mutates one installed runtime byte and proves the gate fails.
- `npm audit signatures --omit=optional` verifies all 390 root and 452 Homey non-optional packages against registry signatures, with 78 and 38 verified attestations respectively. CI and tagged release now require the same checks; omitting optional packages avoids npm's attempt to resolve Toolcraft's bundled private package metadata, and that entire optional graph is removed from the Homey artifact.
- Pruning validates the vendored SDK's runtime export shape before any deletion, then rewrites its package metadata in-place through the preflighted single-link inode. Only runtime name/version/description/license/module entry, the core export, engine range, and required dependency map remain, preventing development scripts, Toolcraft exports, removed declaration paths, publishing fields, and dev dependencies from coupling unrelated repository edits to the Homey artifact.
- The staged app package is likewise reduced to identity, attribution, runtime, engine, and an exact installed SDK dependency; the integrity-pinned SRP helper keeps only its CJS/ESM runtime exports and four real runtime dependencies. Smoke tests reject any reintroduced scripts, dev/type metadata, or declaration-only dependencies, and artifact-level `npm ls --omit=dev` reports no invalid or missing packages (only Homey's expected generated shim is extraneous).
- Other registry dependency manifests retain their inert upstream publishing and development metadata. They are not generically rewritten because their export, browser, engine, and package-manager fields can participate in runtime resolution; the artifact instead rejects install lifecycle scripts, native payloads, removed-path references in the three deliberately minimized manifests, and any invalid or missing production dependency.
- Package README/changelog/security files are removed only when a nonempty LICENSE/LICENCE/COPYING/NOTICE file survives in that same package or the exact package version and archive integrity have been reviewed. Mode normalization now tolerates post-preflight disappearance only for exact development files, emptied directories, and recursive optional-package roots in the approved removal plan; any other missing entry fails as build mutation.
- The dedicated Node 22 Homey runtime CI job now installs `packages/homey-app` with lifecycle scripts disabled after vendoring and before build. A dependency-free source-copy simulation of that exact job order builds, prunes, smoke-loads, and reproduces the 1,301-file, 4,394,845-byte artifact; the workflow test locks the install between vendoring and build.
- Both exact `npm@11.18.0` trusted-publishing bootstrap installs now use `--ignore-scripts`; the workflow test requires both hardened commands, and all GitHub workflow/dependabot YAML parses successfully after the change.
- A shared strict version parser now enforces Node.js 24 before `homey:install`, `homey:verify`, stage publication, prepared-stage re-verification, or guarded run/install work begins. Exact Node 22 probes prove setup and stage verification fail before build or device lookup, while the deployed runtime smoke remains intentionally Node 22-compatible.
- The development guide now mirrors the Hatch lifecycle headings and their build-before-live ordering, uses the verified non-workspace `npm exec --prefix packages/homey-app -- homey ...` syntax, and states package-local working directories for live and release commands; metadata tests prevent the broken workspace form from returning.
- Homey configuration discovery now uses a fresh random mode-restricted `mkdtemp` directory beneath `os.tmpdir()` for every discovery transaction rather than either the shared `/tmp/.cradlewise` filename or a predictable PID path. The wrapper removes the entire directory after discovery whether private Homey settings are available or the SDK-default path is used, concurrent no-settings loads receive distinct directories, and cleanup failure now fails client creation instead of silently accepting residual bootstrap data; simultaneous discovery and cleanup failures remain inspectable in order.
- The bundled SDK applies the same fail-closed rule to its large streamed XAPK workspace and failed-download cleanup, attempting handle close plus directory removal and retaining the original operation together with every cleanup failure. Transaction helpers across bootstrap, stage packing, publication, snapshot verification, manifest validation, and handle closure use explicit failure flags, so even `null` or `undefined` promise rejections remain failures rather than being mistaken for successful completion.
- Crib identifiers now reject bidirectional formatting controls in addition to C0/C1 controls and byte overflow, preventing visually deceptive Homey data identifiers without changing ordinary cloud IDs.
- Exact secret-value scanning now refuses local `.env` or cached configuration sources with any group/world permission bits before reading them. The current local sources are both mode `0600`; links, hard links, empty files, oversize files, and malformed UTF-8 remain independently rejected.
- Stage destination resolution now canonicalizes the nearest existing ancestor before creating missing directories, rejects a canonical path inside or above the source app, and rechecks after creation. A symlinked outside-looking parent therefore cannot create a staging directory inside the repository before rejection.
- A local-only `homey:stage` command now runs the complete verification workflow, rejects an unreviewed CLI before preprocessing, independently rebuilds from an allowlisted source copy, works around Homey CLI 4.3.1's out-of-tree `npm ls` trailing-line bug by building with the stage as its working directory, applies the reviewed pruning, compares the full file/mode/content digest, invokes the pinned CLI packer, extracts and re-digests that archive, and transactionally publishes the artifact with its mode-`0600` sibling verification record.
- Artifact smoke scanning, pruning preflight, and archive extraction reject control-bearing or bidirectionally formatted filenames before acceptance. Verification records use strict fatal UTF-8 decoding, and the Homey package metadata test pins both the declared and locked CLI version to 4.3.1.
- Stock Homey run/install commands are intentionally excluded from the release procedure because default preprocessing bypasses post-build pruning and stock `--skip-build` validates and packs different paths. The guarded launcher pins CLI 4.3.1, refuses contact without `--approve-device-contact`, hashes the current reviewed `.homeybuild`, requires the sibling record and staged tree to match it, then copies the artifact into a private disposable execution directory and repeats the digest, smoke scan, and exact CLI archive round-trip there. A child independently repeats those checks before Homey validation, packing, and runtime loading use that same snapshot; the parent keeps the snapshot until child exit and then removes it even if Homey CLI called `process.exit()`.
- A read-only live Homey smoke test passes against the configured account without printing credentials, tokens, crib IDs, baby names, or raw payloads. The vendored tarball is checked byte-for-byte against a fresh pack of the current SDK.
- Replaced synchronous full-buffer XAPK/APK extraction with a bounded streaming ZIP implementation that validates central and local metadata, names, archive shape, decompressed sizes, and CRC-32 checksums. Stored entries use one reusable buffer, DEX endpoint discovery scans bounded byte windows, and `fflate` is now test-only.
- A real Node.js 22 forced refresh of the current 78 MiB XAPK completes in about 4.1 seconds at 150 MiB peak RSS, down from roughly 398 MiB before streaming extraction. No discovered configuration values, identifiers, credentials, or payloads were logged during profiling.
- The complete root suite passes 296 tests with 92.49% statements/lines, 88.28% branches, and 97.14% functions, followed by declarations, CLI/MCP package smoke, publint, ATTW, dry-run packing, reproducible packing, and production dependency/license validation. Node 20.12.2, 22.22.0, and 24.14.0 all pass the same gate and reproduce identical package bytes.
- Exported a narrow `isTrustedDiscoveredAppConfig()` predicate so Homey can reconstruct persisted values through `AppConfig` and still enforce the exact SDK discovery fingerprint before authentication. The predicate fingerprints immutable own fields directly rather than trusting overridable serialization; malformed, spoofed, or unpinned ManagerSettings values are replaced through fresh verified discovery.
- Freshly discovered Homey configuration is independently rechecked by the wrapper and persisted from immutable fields rather than `toJSON()`, so neither an SDK regression nor an overridden serializer can bypass the Homey trust boundary.
- The Homey wrapper removes the exact legacy public `/userdata/.cradlewise/cradlewise_app_config.json` cache before restoration or discovery. An exact first-run Node.js 22 wrapper profile, including SDK import, verified discovery, private persistence, authentication, and crib discovery, peaks at 166 MiB; a same-process restored run completes in about 1.3 seconds without recreating the temporary cache file.
- Added standard crib connectivity alarm semantics and automatic Flow triggers, explicit Insights history/labels for monitored custom capabilities, Unicode-safe display truncation, fixed privacy-safe cloud failure messages, best-effort credential cleanup, and data minimization that no longer stores baby profile IDs or timezone metadata.
- Connectivity synchronization now respects the SDK's partial-source marker: when only the online-status endpoint fails, Homey preserves the prior alarm value rather than treating the model's default boolean as confirmed offline state.
- Primary crib-state failures now keep initial connections unavailable and count as polling failures even when auxiliary endpoints respond, while online-only and firmware-only partial responses continue to preserve usable monitoring data.
- Pairing filters cribs whose primary state source is unavailable, and repair rejects the same condition before touching stored credentials.
- Attention aggregation now uses three-valued logic: any true flag raises the alarm, all known-false flags clear it, and partial unknown flags preserve the prior Homey value.
- Homey-visible and logged failures now use context-specific fixed messages unless the exception exactly matches an allowlisted app-authored error, preventing upstream exception strings from disclosing crib IDs, account data, URLs, or response text.
- Reconnect now publishes the candidate client only after capability synchronization, Homey availability, and polling setup all succeed. Generation checks after each asynchronous commit boundary prevent deletion from recreating a timer or retaining a candidate client while queued teardown is draining.
- Deterministic differential testing read 676 entries across 80 valid mixed stored/deflated archives, while 320 independently mutated archives were all rejected during metadata, decompression, size, or checksum validation without hangs.
- Archive input preflight now rejects symbolic links, hard links, FIFOs, and other non-regular files before blocking reads, then verifies device and inode identity again after opening to close cross-platform path-replacement races.
- Pairing now snapshots immutable identity/name records, deduplicates crib IDs before status reads, rejects bounded/control-bearing identities, caps a login result at 64 devices, and uses intrinsic `Map` operations so overridden collection accessors cannot change selection semantics.
- Existing devices migrate newly declared capabilities during every full reconnect. All custom capability presentations are passive read-only sensors, and primary-source failures preserve every established sensor value while still allowing independently sourced connectivity to update.
- Restored and freshly discovered Homey configuration now passes through descriptor-only own-property extraction before `AppConfig` reconstruction and fingerprint validation; inherited fields, accessors, and throwing trust predicates cannot reach persistence or authentication.
- Pairing forms, repair device data, persisted rollback credentials, and device settings updates now accept only reviewed own data properties. Values are copied before queueing or cloud work, so later caller mutation and accessors cannot change reconnect, polling, or rollback behavior.
- Repair rechecks its session generation after settings persistence and after device reconnect. Disconnect during persistence restores prior credentials without starting reconnect; disconnect during reconnect restores both prior settings and prior connection, with fixed-text containment if either rollback step fails.
- Homey device and driver boundaries dispatch Map lookup, Map size/iteration, status-source membership, settings membership, and descriptor ownership through captured intrinsics. Hostile Map subclasses, overridden intrinsic `.call` properties, and status arrays with lying or throwing `includes` methods cannot alter discovery or degraded-state decisions.
- Each updated crib is reduced to one frozen, validated, source-aware state snapshot before capability publication. Unavailable source getters are never touched, malformed source lists fail closed, later cloud-object mutation cannot mix observations, and crib identity is checked again after asynchronous Homey writes before commit.
- Capability publication records prior values, checks lifecycle currency before and after each Homey write, and retains a rollback token until candidate identity, availability, client, timer, and state are fully committed. Any write, deletion, supersession, identity, or availability failure restores successful writes in reverse while preserving concurrent external changes and the original error.
- Capability rollback also contains failures while reading the current value or writing/logging the restoration, so secondary Homey API or logger faults cannot replace the original publication error. Unavailable and absent capabilities still short-circuit before value reads.
- Reconnect snapshots Homey's device availability before candidate work and tracks the last reviewed unavailable message. If candidate availability changes or partially succeeds before a later reconnect failure, prior unavailability is restored with its reviewed message or the generic safe fallback; restoration and logger failures remain contained.
- Built-artifact validation recursively rejects sensitive filenames, links, special files, hard links, native addons, and install lifecycle scripts. Child-process timeouts now wait for termination, escalating from `SIGTERM` to `SIGKILL`, before rollback or build cleanup proceeds.
- Sensitive-name policy explicitly rejects Homey CLI `env.json` as well as dotenv variants, credential stores, control-bearing names, and bidirectional-formatting filenames in reviewed builds, published stages, and packed archives.
- Repository ignore policy now blocks `env.json` at every depth in addition to dotenv variants, while a root metadata test requires both `.gitignore` and `.homeyignore` to retain their matching credential-file rules.
- The 20,000-object artifact ceiling now counts directories as well as files. Source-copy validation and whole-build pruning preflight reject excessive trees before mutation, while smoke, reproducibility, execution-snapshot, and CLI archive checks enforce the same bound afterward.
- Source-copy preflight also rejects control/bidirectional filenames and more than 512 MiB of regular-file input before writing any destination entry. Whole-build pruning now accumulates the final artifact's 64 MiB limit during its complete safety/mode plan, so an oversized sparse file fails before optional packages or development files are removed.
- Poll-interval settings now run through the same device queue as reconnect, refresh, and deletion, preventing a stale reconnect from overwriting a newer interval or a queued settings change from recreating polling during teardown.
- Pairing carries the already validated crib ID into its immutable record instead of reading mutable SDK state again. Device connection and every later refresh also revalidate that cloud updates have not changed the paired identity.
- Toolcraft is now a default-installed optional SDK dependency. An isolated packed consumer proves the core export works with optional dependencies omitted, while the normal package smoke still verifies CLI, Toolcraft, and MCP behavior.
- Homey builds use tested lockfile reachability to subtract the Toolcraft-exclusive dependency closure after the Homey CLI finishes. Exact integrity-pinned declaration-only dependencies misclassified by the SRP helper are also excluded while any dependency shared with a runtime path is preserved. Removing the optional graph first reduces the stage from 75 to 39 packages; subsequent declaration pruning brings the final runtime from 16.95 MB to about 5.57 MB across 1,424 files without removing any core runtime dependency or the CLI's platform-specific build dependency.
- The built-runtime scanner now enforces reviewed license metadata or license files for every staged package, in addition to its existing native-addon, lifecycle-script, link, special-file, sensitive-name, and size checks.
- Built artifact content, runtime package metadata, reviewed license files, and local sensitive-value sources are read through bounded no-follow descriptors with path-to-handle identity and post-read timestamp checks. Secret sources additionally require strict UTF-8, and replacement, linked, empty, oversized, and malformed fixtures fail closed.
- Built-artifact and reproducibility directory traversal now keeps a no-follow directory descriptor open across listing and recursive inspection, then rechecks both the descriptor and pathname identity. Deterministic path-swap fixtures prove a replaced directory cannot be scanned or hashed as if it were the original tree.
- Paired-device identity now follows the same descriptor-only trust boundary as repair and settings data: the crib identifier must be an own Homey data property, inherited values and accessors are rejected without invocation, and descriptor lookup uses a captured intrinsic.
- Generated manifest tests recursively require English-facing strings to be nonempty, trimmed, bounded, and free of control or bidirectional formatting characters. Formatted Flow titles must reference exactly their declared arguments, and the baby-presence wording now reads naturally in the Homey editor.
- Pairing, repair, and device refresh now use one frozen status-source snapshot validator. Non-array, duplicate, unknown, or oversized source metadata is rejected consistently, while captured array membership ignores overridden instance methods.
- Poll timer allocation now requires a concrete Homey handle. A null or undefined result fails before the existing timer, client, capabilities, or availability can be replaced, preventing a nominally successful reconnect from silently losing future refreshes.
- Homey availability is now read inside reconnect's guarded transaction and must be an exact boolean. Malformed platform state fails before client creation, while a throwing platform getter is reduced to a reviewed public connection error instead of leaking its private message.
- Driver and device error reporting now dispatches through a captured non-throwing helper. Throwing logger methods or getters cannot escape pairing login, suppress readable cribs, abort initialization, leave a polling rejection uncontained, or prevent teardown from clearing and releasing the active client.
- App, driver, and device readiness messages now use the same captured non-throwing pattern, so a broken informational logger cannot turn otherwise successful initialization into a Homey startup failure.
- Client creation snapshots credentials, Homey settings methods, and the validated SDK export surface before configuration awaits. Captured methods use intrinsic dispatch and constructors use intrinsic construction, so caller mutation, replacement methods, and overridden `.call` properties cannot redirect private config reads, writes, trust checks, or authentication.
- The tag release workflow independently reruns Homey type checks, tests, and built-runtime smoke under Node.js 22, then restores pinned Node.js 24/npm 11.18.0 before packing and trusted publishing.
- Stored invalid poll intervals fall back to the supported default for both initial connection and later retry, with a single fixed diagnostic instead of permanently blocking cloud recovery. Randomized Unicode/control-string tests and unavailable-source getter tests exercise Homey-facing normalization without reading stale fields.
- Built-artifact checks are import-safe and have isolated negative fixtures for environment files, symbolic and hard links, native addons, install lifecycle scripts, missing licenses, reviewed license files, and Homey's exact generated shim exception.
- A newer pairing login clears prior results immediately and superseded work no longer logs stale crib failures. Serialized repair attempts snapshot validated credentials when submitted, so queued mutable form objects cannot change the later transaction.
- Reconnect allocates its replacement poll timer before publishing candidate state, so a timer-subsystem failure leaves the working client, timer, and capabilities untouched. Refresh stress sends 200 timer callbacks plus 100 manual Flow calls through one blocked update and proves they coalesce to one request, count a shared failure once, recover on retry, and become inert after deletion.
- Credential settings and repair fall back to the supported default when an unrelated legacy poll value is corrupt, while an explicitly submitted invalid poll interval remains a hard validation error. Repair now uses the same e-mail labels and placeholder as initial pairing.
- Simultaneous device startup now shares one private ManagerSettings restoration or verified discovery operation per Homey instance. A 32-client fixture proves one read/discovery/write transaction, reconstructs a distinct trusted `AppConfig` instance for every client, restores the saved value on later calls, and evicts failed shared loads for retry.
- The pruned built runtime loads under Node.js 22 in 0.49 seconds at about 87 MB peak RSS on the final workstation benchmark. Type-only pruning is pinned to the reviewed `cognito-srp-helper@2.3.5` archive and fails closed if its version, integrity, or dependency declarations change.
- Homey device uninitialization and user deletion now share one idempotent teardown promise. Shutdown during a blocked cloud refresh drains queued work, suppresses late capability publication, clears polling, and releases the active client's credentials exactly once.
- Reproducibility hashing is now import-safe and directly fixture-tested for creation-order independence, path/mode/content sensitivity, unsafe roots, symbolic and hard links, and sparse artifacts above 64 MiB. Hashing checks the post-read byte count against pre-read metadata so a changing file fails rather than producing misleading size evidence.
- Generated-manifest validation is import-safe and tests its exact verified-app blocker, manifest-drift precedence, captured-output ceiling, nonzero exits, and timeout termination. Release subprocess completion now waits for stdio closure, preventing trailing validation or MCP output from escaping inspection.
- Optional-package pruning validates dependency maps as nonempty string records, rejects a linked build root or linked package ancestor, and compares every removal target with its canonical in-build path before recursive deletion. The complete dependency tree and declaration-removal plan are validated before the first deletion, so a later unsafe package cannot leave a partially pruned artifact.
- Pairing and repair now use Homey's session-disconnect handler to erase retained pairing credentials/results and invalidate active work. Cancelled pairing stops before later discovery batches; cancelled repair prevents active or queued attempts from persisting credentials and suppresses stale failure logs while still releasing scoped clients.
- The pruning lockfile is opened with no-follow/nonblocking flags after a single-link regular-file preflight, read within a 16 MiB ceiling, and rechecked by device, inode, size, modification/change timestamps, and strict UTF-8 before parsing. Symbolic, hard-linked, oversized, and malformed lockfiles fail before build access.
- Pruning now validates every canonical removal target and the type scope before its first recursive deletion. A linked later target therefore leaves earlier optional packages intact instead of producing a partially pruned artifact, and Toolcraft being reachable through the required graph fails before mutation.
- Runtime Flow action and condition metadata is contract-tested to retain the `driver_id=cradlewise` filter. Dispatch uses intrinsic `Reflect.apply` rather than a selected method's mutable `.bind`, and device condition helpers fail once teardown begins instead of exposing cached state from a deleted device.
- Availability-message sanitization now requires both upstream text and fallback text to match the explicit reviewed app-authored message set. Dedicated probes feed credentials, crib IDs, private URLs, session tokens, AWS-style keys, object messages, and `AggregateError` instances through both positions and verify only the generic cloud message is exposed.
- Built-runtime scanning now reads every staged file and rejects private-key blocks plus AWS, npm, and GitHub token signatures even when embedded in binary content. The first full scan found only an AWS SDK example key in declaration documentation; rather than exempt it, staging now removes all non-runtime `.d.ts`/`.d.ts.map` files and empty type directories, and smoke testing locks their absence.
- Built smoke also loads exact markers from the ignored root `.env`, active `CRADLEWISE_LOGIN`/`CRADLEWISE_PASSWORD` variables, and confidential Cognito cache fields through bounded regular-file reads, then compares them against every artifact file without printing any value. Shared non-secret configuration such as the AWS region is intentionally excluded to avoid false positives in generic SDK code.
- Built-runtime scanning now additionally considers every bounded credential-shaped local environment value, rejects common credential stores and private-key filenames, and structurally validates package `main`, `module`, exact exports, wildcard exports, and export subpaths before loading the artifact. Constructor smoke instantiates the vendored SDK configuration, auth, and client surfaces without network access and confirms the pruned legacy realtime path degrades safely.
- Every spawned Homey CLI build, validation, packing, and contact process now receives only a reviewed operating-system environment with headless mode and startup-notifier suppression forced on. The final approved contact child may additionally receive exact `HOMEY_PAT`; all other Homey/Athom, proxy, Node/OpenSSL startup, dynamic-loader, credential, and redirect variables are removed. Termination signals are forwarded, a second signal escalates immediately, an unresponsive child is killed after a bounded grace period, and all timers/listeners are cleaned up under success and failure.
- The exact Node 20 gate exposed a timeout-liveness defect in authentication: a temporary `AbortSignal.timeout()` source composed through `AbortSignal.any()` could disappear while an SDK promise ignored aborts. Authentication now retains one controller and an explicit timer until cleanup, preserving manual cancellation, standalone-process liveness, retryability, and deterministic `TimeoutError` rejection across every supported Node runtime.
- A single non-overcommitted randomized soak completed 522 cross-version rounds across exact Node.js 20.12.2, 22.22.0, and 24.14.0. Each round exercised the highest-contention SDK auth/client/config/realtime/vendoring/ZIP tests plus Homey device, driver, configuration, and guarded-launch lifecycle tests; every round passed. A deliberately concurrent second stress loop was discarded after it starved multiple 20–75 ms fake-deadline tests, and its exact shuffle seed passed immediately once run without artificial CPU oversubscription.
- After the final process-group, Windows-environment, artwork-reproduction, and auth-deadline changes, a second single-loop soak completed 631 additional exact-runtime rounds with the same cross-version workload and full Homey suite. The two accepted soaks total 1,153 clean rounds without a product failure.
- CI and release runners are pinned to Ubuntu 24.04 and exact Node.js patch releases. The trusted-publishing npm CLI archive is downloaded privately and checked against a pinned SHA-512 SRI before both installs; production lockfile reachability, release-time dependencies, registry origins, integrity metadata, and npm publication-existence failures are independently validated.
- Root configuration and ZIP fixtures now track and remove every temporary workspace after each test. Repeated stress runs, the complete 296-test root gate, the complete 257-test Homey gate, and final artifact verification leave no test-created `cradlewise-*`, `homey-*`, or `reviewed-*` residue in the system temporary directory.
- Store-facing copy explicitly identifies this as an unofficial integration and states that it is not a safety-critical baby monitor or replacement for the official Cradlewise app.
- Store presentation now follows Homey's current review guidance more closely: the plain-text readme is two concise paragraphs without URLs or Markdown, while distinct driver artwork uses a clean white background at all three required resolutions and is generated deterministically from a repository script. PNG tests reject metadata-bearing or malformed chunks and require white corner pixels.
- Generated-manifest tests now bind runtime normalization to presentation metadata: all percentage capabilities remain integer 0–100 sensors with in-range numeric Flow examples, sleep/power enum token examples stay inside their declared domains, every boolean custom capability retains both automatic trigger IDs, and every declared custom device capability is unique and defined.
- The CommonJS-to-ESM SDK boundary now uses a loader factory whose in-flight import is shared and whose failed import or missing-export validation is evicted before retry. A concurrent failure/recovery fixture closes the wrapper's final uncovered lines, and client credential cleanup uses intrinsic `Reflect.apply` rather than trusting a mutable `.call` property.
- Pairing and repair now authenticate through account discovery without requiring live crib telemetry, retain verified replacement credentials for scheduled offline recovery, and reserve Homey's generic invalid-credentials result for explicit Cognito rejection or an unknown account.
- The current Android bundle snapshot, artifact hashes, inbox routes, exact nested metadata/message models, existing mobile-registration lookup, saved-photo precedence, limitations, and safe reinspection procedure are recorded in `docs/android-bundle-notes.md`; no APK, XAPK, DEX, JADX output, expiring URL, or raw payload is retained.
- Android live-view tracing now distinguishes two unrelated photo paths: cloud-generated inbox/video-moment stills and the camera button's phone-local PNG capture from the active WebRTC renderer. A private proof also reproduced the authenticated `/videoRoom` Janus subscriber flow, received H.264 RTP, decoded one fresh 1280×720 frame, and immediately deleted all temporary media and credentials. Homey live capture remains intentionally disabled until a bounded, licensed Homey-compatible H.264 decoder is reviewed and tested.
- Homey's saved-photo Flow action reuses only current account registrations, never provisions or removes a mobile device, rejects local or credentialed media URLs, verifies JPEG/PNG/WebP signatures, caps headers, bytes, and chunks, and enforces one deadline across response acquisition and every body read even when abort or cancellation is ignored.
- Homey photo lookup, response descriptors, stream chunks, reader cleanup, image creation, registration, update, and teardown failures are contained behind fixed cause-free messages so signed media details cannot reach Flow errors or platform logs.
- Android discovery and signed API requests now use Node's intrinsic URL constructors, strict index-based decimal length parsing, and frozen own configuration fields; writable global constructors, mutable regular-expression behavior, and an overridden `AppConfig.toJSON()` cannot redirect bundle discovery, signed credentials, request parameters, or trusted cache contents.
- CI and tagged release gates regenerate the Homey SDK vendor and then require the committed lockfile and tarball to remain byte-identical, closing the stale-vendor blind spot while declaration smoke covers the Android-derived nested inbox types under both exact optional-property modes.
- Homey pairing now uses a custom accessible credentials view with inline, focusable error feedback instead of the built-in blocking alert. Pair and repair retain their original boolean/throw contracts behind an inline result adapter, and logs add only sanitized stage/setup/category breadcrumbs suitable for Homey's built-in diagnostic reports.
- The Homey-only sign-in failure was reproduced through a real `ManagerDrivers` pair session while the same credentials continued to pass the direct live smoke. The failure was not account-related: Homey's app container has no operating-system home directory, while the Node-conditioned SDK/AWS dependency graph attempted both the SDK default cache path and the AWS shared credential provider chain through `os.homedir()`.
- The SDK default cache path is now resolved only when no explicit cache path is supplied, so Homey's explicit temporary bootstrap path never touches `os.homedir()`. The Homey package also generates a deterministic CommonJS authentication/config/client runtime with browser-conditioned AWS clients and external Node built-ins. This removes `~/.aws` discovery from Cognito identity exchange while preserving bounded Android bundle discovery, and the verifier requires the generated bytes to match a fresh build.
- A real Homey pair-session `login_inline` call now returns `{ ok: true }` for the independently verified account while its crib is offline. The complete 315-test Homey suite, strict coverage gates, debug validation, smoke load, exact pack round-trip, and reproducible stage verification pass for the fixed artifact.
- The custom credentials view no longer calls `Homey.setNavigationClose()`, because that session-level override replaced the later device list's Add navigation with a redundant Close button. The form also relies exclusively on Homey's title/subtitle shell rather than rendering a second embedded header. A real installed Homey pair session proved the complete chain: inline login succeeded, `list_devices` returned Michael's Crib, the selected payload was accepted by `createPairSessionDevice`, and the resulting Homey device was available with all 14 declared capabilities.

## 2026-07-06 — Verified controls, sleep insights, and Homey Flows

- Traced Android 2.57.8's current certificate provisioning and AWS IoT shadow protocol, including the exact 0–99 `actuator.amplitude` and `soundSynth.volume` controls and 1–60 minute smart-lock fields.
- Added `CradlewiseController` with bounded certificate provisioning, SigV4 S3 retrieval, MQTT mutual TLS, correlated shadow requests, confirmation polling, start/stop, level, lock, and unlock operations.
- Added CLI/SDK commands for control status, start, stop, lock, unlock, and the `sleep-insights` analytics alias.
- Added Homey on/off state, interactive bounce and sound sliders, a control-lock toggle, sleep-insight capabilities, and Advanced Flow actions that start chosen levels with or without locking.
- Verified the protocol against the real crib and left it stopped and unlocked after testing.

## 2026-07-06 — Homey percentage, mTLS, and diagnostics correction

- Corrected Homey control capabilities to use unitless 0–99 levels matching the native app, preventing values such as 5000% in the device UI.
- Externalized `mqtt` from the browser-conditioned generated authentication bundle so Homey loads MQTT's Node.js mutual-TLS transport instead of its browser WebSocket transport.
- Verified the exact generated Homey runtime against the real crib by reading control state and changing bounce intensity, then stopped and unlocked the crib.
- Added a sanitized app settings diagnostics page with report generation, copy, reset, aggregate control/connection/sleep counters, and a bounded recent-event ring.

## 2026-07-06 — Native dynamic soothing levels

- Re-inspected Android 2.57.8 and corrected the Homey control model: the dashboard uses Off plus visible levels 1–5, encoded as `-1` for Off in the UI and shadow indices 0–4 in `bounceLevel` and `musicLevel`.
- Added separate maximum-bounce and maximum-sound percentage capabilities backed by `maxBounceLimit` and `maxVolumeLimit`; the crib's reported level recipes perform the dynamic mapping beneath those maximums.
- Preserved the SDK's low-level 0–99 amplitude and volume operations while adding native-level controller methods for Homey and Flows.
- Removed confirmation polling from rapid level and maximum updates. Homey now publishes one accepted shadow update and projects the requested state immediately, avoiding repeated-control timeouts.
- Defined Homey's On behavior: reuse the saved Off/1–5 selections, start only selected channels, and use level 1 for both only when both saved selections are Off.

## 2026-07-06 — Fast, timeout-resistant crib controls

- Removed the remaining post-update confirmation polling from start, stop, lock, and unlock. Every control now completes after one accepted AWS IoT shadow update and projects the requested state locally.
- Replaced per-request MQTT subscribe/unsubscribe cycles with one persistent four-topic response subscription per controller connection. Correlated requests can now overlap safely without one request unsubscribing another.
- Added immediate rejection of all pending control requests when the MQTT connection closes, avoiding waits until the full operation timeout after a known disconnect.
- Serialized controller shadow updates after a live 30-request concurrency test showed that the crib rejects an unbounded simultaneous flood. Thirty queued bounce updates and thirty queued sound updates each completed in about 1.7 seconds without rejection, while warmed individual controls completed in roughly 50–80 milliseconds.
- Added latest-value coalescing for Homey bounce and sound level controls. A rapid burst executes the in-flight value and then only the newest pending value instead of replaying every intermediate selection.
- Verified the installed app through Homey's local device API: warmed bounce and audio changes completed in 69–100 milliseconds, five simultaneous changes coalesced and completed in 143–155 milliseconds, no request timed out, and the crib was confirmed stopped and unlocked afterward.

## 2026-07-06 — Native-owned maximum levels

- Changed maximum bounce and maximum sound from Homey sliders to read-only percentage sensors. The native Cradlewise app remains the only UI for configuring these bounds, while Homey continues to display their reported values, retain Insights, and emit automatic change Flow triggers.
- Removed Homey's `measure_battery` capability and internal-battery energy declaration. Although the cloud model exposes a battery-like telemetry field, this crib is not a user-serviceable battery device and Homey's permanent battery badge was misleading; power-source status remains available separately.
