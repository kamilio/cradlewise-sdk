# Android bundle research notes

These notes record the mobile-app evidence used to maintain the unofficial, read-only SDK. They are implementation research, not a supported Cradlewise API contract.

## Inspected artifact

Inspection date: **2026-07-05**

| Property            | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Android package     | `com.cradlewise.nini.app`                                          |
| App version         | `2.57.8`                                                           |
| Version code        | `211`                                                              |
| Minimum Android SDK | `24`                                                               |
| Target Android SDK  | `36`                                                               |
| XAPK size           | `81,466,125` bytes                                                 |
| XAPK SHA-256        | `d77a103c2819f987772ab8207bd6c8b1f0d0b9216db8ee550a5c9b36ce3e8865` |
| Base APK entry      | `com.cradlewise.nini.app.apk`                                      |
| Base APK size       | `67,321,547` bytes                                                 |
| Base APK SHA-256    | `037473e3dfbe15acddc15d6afab1d4706257e731395701d3f93930f9aa676f0e` |
| Base DEX files      | `classes.dex` through `classes13.dex`                              |

The bundle was obtained through the same APKPure metadata and approved CDN-host flow implemented by `src/config.ts`. Time-limited download URLs are intentionally not recorded. Neither the XAPK nor decompiled sources are committed.

## Derived trust fingerprints

The non-secret SHA-256 pins in `src/discovery-trust.ts` were derived from the reviewed bundle configuration:

| Purpose                         | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| Cognito/API configuration tuple | `5314aee9b23b585706300d6b7d86ad6d74125c39772b21003ce953c2e5315413` |
| AWS IoT endpoint                | `bd1d018c23681cc4457abc1f288a1b37810e5157a31116b1798a2c5c5678ba75` |

The tuple hash covers the user pool, app client ID, app client secret, identity pool, region, and API base URL in that fixed order. The underlying values are intentionally not duplicated in this research note. A future bundle must not replace either pin without a fresh artifact review and matching tests.

## Reproduction outline

1. Use the explicit Android configuration-discovery path in `src/config.ts` to obtain the current XAPK in a private temporary directory.
2. Record the XAPK hash and extract only the base APK entry named by `manifest.json`.
3. Record the base APK hash and inspect `AndroidManifest.xml`.
4. Decompile the base APK with JADX 1.5.5 into a temporary directory.
5. Search the generated Java and raw DEX strings for endpoint paths, query names, and serialized model fields.
6. Delete the XAPK, APK, DEX, and decompiler output after recording non-secret findings.

JADX returned exit status `3` because some methods could not be reconstructed, but it produced enough source and bytecode-derived strings to corroborate the findings below. Empty decompiler branches were not treated as evidence; their query names were confirmed from raw DEX string tables.

## Inbox and photo API

The current mobile app contains `feature/videomoments/api/BackendService.kt` behavior with these read and update routes:

- `GET /inbox/v2`
- `PUT /inbox`

Only the GET route is implemented by this repository. The SDK remains read-only by default, and the update route is documented solely to explain the Android model.

The GET method accepts these optional query parameters:

- `device_id`
- `page_size`
- `tags`
- `baby_id`
- `message_type`
- `cradle_id`
- `next_token`
- `message_id`

The Video Moments screen calls the endpoint with a page size of `50`, `tags=baby`, `message_type=baby`, the current baby ID, the current cradle ID, and optionally a message ID. Although `device_id` is nullable in the Kotlin service wrapper, a live read on 2026-07-05 returned HTTP 400 with `device_id is invalid.` when it was omitted.

The screen obtains `device_id` from `AppUtils.getDeviceId()`. Android persists that value from the `deviceId` field returned by the certificate/bootstrap device configuration; it is not the crib ID. Creating a new value through `POST /cradles/pairedUsers/v3` is state-changing and remains outside this repository's read-only boundary.

An existing registered identifier can instead be discovered without mutation through `GET /babyProfiles/{babyId}/userDevices?email_id={accountEmail}`. Its response contains `user_devices`; each matching account entry contains a `devices` list with `device_id`, device metadata, registration time, and last-connected time. The observed response used `no_of_devices=-1` as an unspecified-count sentinel while still returning populated device lists. The live account check confirmed that an existing registered device ID is accepted by `/inbox/v2`. The SDK filters entries to the signed-in e-mail address, deduplicates valid identifiers, and retries the next registered ID only when the service explicitly rejects one as invalid.

The response model exposes:

- `baby_notifications`
- `cradlewise_notifications`
- `enable_red_dot`
- `all_tags`
- `eol_message`

Each message may include:

- `message_id`
- `message_time`
- `message_type`
- `notification_id`
- `title`
- `body`
- `priority`
- `content_url`
- `thumbnail_url`
- `presentation_image_url`
- `content_type`
- `aspect_ratio`
- `external_url`
- `button_text`
- `is_read`
- `is_starred`
- `status`

Known `content_type` values are `image`, `video`, `audio`, and `normal`. For a Homey-compatible still image, prefer `presentation_image_url`, then `thumbnail_url`, then `content_url` only when `content_type` is `image`.

## Repository mapping

- `CradlewiseClient.getInboxMessages()` performs the signed, read-only `GET /inbox/v2` request and validates a bounded response.
- `CradlewiseClient.getUserDeviceIds()` reads existing registered app-device identifiers from the account's `userDevices` endpoint; it never provisions or removes a device.
- `CradlewiseClient.getLatestCribPhoto()` selects the newest timestamped usable HTTPS still-image URL, falling back to service order when timestamps are unavailable.
- The Homey `Get the latest crib photo` Flow action returns an image token.
- Homey downloads that image without Cradlewise authorization headers, refuses redirects, IP literals, single-label hosts, and special-use local DNS names, accepts JPEG/PNG/WebP only after matching the byte signature, and enforces Homey's 5 MB image limit.
- Photo lookup uses account discovery and the inbox service, so it does not require the crib's live status endpoints to be available.

## Pairing implication

Account authentication and crib discovery are separate from live crib telemetry. The Android evidence and existing API behavior support listing a discovered crib even when its state, online-status, and firmware endpoints are unavailable. Homey pairing and repair therefore validate authenticated discovery only; normal polling is responsible for showing the crib as unavailable or offline afterward.

## Open questions

- The inbox service is undocumented and may change without notice.
- The ordering guarantee for `baby_notifications` is inferred from the mobile screen's use of the first page and should be rechecked after Android app updates.
- Registered app-device IDs may be rotated or removed. Inbox lookup therefore retries only IDs returned by the current account response and only after the API explicitly reports an invalid device ID.
- Media URL hostnames and expiry periods are response-dependent. Homey therefore validates each URL at use time and does not persist it.
- No live account request was needed for this inspection. A credentialed integration test may be run manually, but it must not log response URLs because they may contain temporary signatures.

## Refresh checklist

When a newer Android bundle is inspected, update this document in the same change that updates any derived SDK behavior:

1. Record the inspection date, app version, version code, package name, SDK levels, artifact sizes, and SHA-256 hashes.
2. Compare the base APK entry and DEX count before trusting prior extraction assumptions.
3. Recheck `/inbox/v2`, `/inbox`, `/babyProfiles/{babyId}/userDevices`, every query name, response field, device-ID source, content type, and the mobile screen's page size and ordering behavior.
4. Recompute the trusted application-configuration fingerprints if Cognito, API, or IoT values changed; do not accept a new value solely because its hostname shape looks plausible.
5. Rerun the SDK and Homey tests, regenerate the vendored SDK archive, prepare a reproducible Homey stage, and install only that verified stage.
6. Delete all downloaded bundles, extracted APKs, DEX files, decompiler output, and expiring media URLs after the non-secret findings are recorded.
