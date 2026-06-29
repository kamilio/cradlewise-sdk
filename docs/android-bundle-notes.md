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

The package/version metadata, XAPK size and hash, base APK entry, and base APK size and hash were independently re-fetched and reverified on **2026-07-05** while checking the inbox model classes. The temporary XAPK, APK, and JADX output were removed after the bounded findings below were recorded.

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

The response declarations were verified in both the feature-local and shared model copies:

- `com.cradlewise.nini.feature.videomoments.api.model.InboxMessageV2Response`
- `com.cradlewise.nini.feature.videomoments.api.model.MessageData`
- `com.cradlewise.nini.core.commons.api.model.InboxMessageV2Response`
- `com.cradlewise.nini.core.commons.api.model.InboxMessagesV2Data`

The three nested envelope wrappers use the corresponding `InboxMessageV2ResponseEnableRedDot`, `InboxMessageV2ResponseAllTags`, and `InboxMessageV2ResponseEolMessage` classes in each package. Recording both copies matters because future app versions may remove one layer or let their schemas diverge.

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

An existing registered identifier can instead be discovered without mutation through `GET /babyProfiles/{babyId}/userDevices?email_id={accountEmail}`. Its response contains `user_devices`; each matching account entry contains a `devices` list with `device_id`, device metadata, registration time, and last-connected time. The observed response used `no_of_devices=-1` as an unspecified-count sentinel while still returning populated device lists. The live account check confirmed that an existing registered device ID is accepted by `/inbox/v2`. The SDK filters entries to the signed-in e-mail address, deduplicates valid identifiers, prefers the most recently connected registration when timestamps are present, and retries the next registered ID only when the service explicitly rejects one as invalid.

The response model exposes these bounded envelope fields:

- `baby_notifications`
- `cradlewise_notifications`
- `enable_red_dot`
- `all_tags`
- `eol_message`

The Android model represents each of `enable_red_dot`, `all_tags`, and `eol_message` as a nullable object with `baby_notifications` and `cradlewise_notifications` members. Those members contain booleans, string lists, and nullable strings respectively. The SDK validates these nested types even when the top-level notification arrays are omitted.

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

The current Android classes model `message_id` and `notification_id` as integers; `is_read` and `is_starred` as nullable booleans; and the remaining listed message metadata as nullable strings. The SDK exposes and validates all of these fields.

Known `content_type` values are `image`, `video`, `audio`, and `normal`. For a Homey-compatible still image, prefer `presentation_image_url`, then `thumbnail_url`, then `content_url` only when `content_type` is `image`.

## Repository mapping

- `CradlewiseClient.getInboxMessages()` performs the signed, read-only `GET /inbox/v2` request and validates a bounded response. A recognized empty envelope containing fields such as `enable_red_dot`, `all_tags`, or `eol_message` remains a valid no-media result even when both notification arrays are omitted.
- `CradlewiseClient.getUserDeviceIds()` reads existing registered app-device identifiers from the account's `userDevices` endpoint; it never provisions or removes a device. Null `user_devices` lists, or a recognized count-only envelope that omits the list, are treated as an empty registration set so Homey can provide its explicit official-app guidance. Arbitrary objects are rejected as unexpected responses.
- `CradlewiseClient.getLatestCribPhoto()` selects the newest timestamped usable HTTPS still-image URL, falling back to service order when timestamps are unavailable.
- The Homey `Get the latest crib photo` Flow action returns an image token.
- Homey downloads that image without Cradlewise authorization headers, refuses redirects, IP literals, single-label hosts, and special-use local DNS names, accepts JPEG/PNG/WebP only after matching the byte signature, and enforces Homey's 5 MB image limit.
- Photo lookup uses account discovery and the inbox service, so it does not require the crib's live status endpoints to be available.

## Live-view screenshot behavior

The camera button shown over Android's live crib video is separate from the inbox/video-moment feature. The current app does not call a REST snapshot endpoint when that button is pressed.

The traced path is:

1. `HomeActivityNew.handleCameraIvClick()` calls `getBitmapFromVideoView()`.
2. `HomeActivityNew.captureFrame()` adds a one-shot frame listener to the active WebRTC `SurfaceViewRenderer` at full scale.
3. The resulting Android `Bitmap` is passed to `VideoViewModel.setVideoBitmap()`.
4. `VideoViewModel.storeScreenShot()` calls `FileUtils.saveScreenshotToGallery()`.
5. `FileUtils` compresses the bitmap as PNG and inserts it through Android `MediaStore`. On Android 10 and newer the destination is `DCIM/Cradlewise`; older Android versions use the app's external-storage directory.

The saved URI is used only to open the image in the Android gallery. No upload, inbox update, snapshot API request, or crib command follows this path. Therefore the official Android screenshot is produced on the phone from the already-playing WebRTC frame, even though the underlying video originates at the crib.

This is distinct from cloud-generated inbox/video moments. Those records contain temporary still or thumbnail URLs and remain the source used by `CradlewiseClient.getLatestCribPhoto()` and Homey's `Get the latest crib photo` action.

## Remote live-video room

The current Android app obtains remote live-video credentials with:

- `GET /cradles/{cradleId}/videoRoom?deviceId={registeredDeviceId}`

The response includes a Janus load-balancer WebSocket endpoint, opaque ID, room ID, PIN, short wait limits, and a video-room HMAC secret. These values are session credentials and must never be logged, persisted, committed, or exposed through a Homey Flow token.

Android opens the endpoint with WebSocket subprotocol `janus-protocol` and signs these headers in this order:

- `X-Origin`
- `X-CId`
- `X-DId`
- `X-Timestamp`
- `X-SId`

`X-Signed-Keys` contains that comma-separated list. The canonical input is each lower-case header name, a colon, and its value, joined with newlines. Android hashes the canonical input with SHA-256, then computes a lower-case HMAC-SHA256 hex digest of that hash using the video-room secret and prefixes it with `HMAC `.

The observed Janus sequence is:

1. Create a Janus session.
2. Attach `janus.plugin.videoroom` as an application publisher so Janus returns the existing publisher list.
3. Select the crib publisher whose ID ends in `_cradle` or whose display name ends in `_remote`.
4. Attach a second VideoRoom handle and join it as a subscriber with the room PIN, private ID, and crib feed ID.
5. Accept the Janus SDP offer, return an SDP answer with a `start` request, and exchange trickle ICE candidates in both directions.
6. Keep the Janus session alive while media is being received.

On **2026-07-05**, a private, read-only proof reproduced this sequence against the signed-in account. It joined the room, received the crib's H.264/Opus WebRTC stream, reassembled an H.264 IDR frame from 16 RTP packets, and decoded a fresh `1280 × 720` JPEG. The temporary encoded frame and JPEG were mode-restricted and deleted immediately. No account identifiers, room values, media, or expiring credentials were retained.

Homey can perform the HTTPS, HMAC, WebSocket, Janus, ICE, and RTP portions in JavaScript. A fresh Homey image still requires an H.264 decoder and JPEG/PNG encoder, however. The official Android app relies on Android/WebRTC's native decoder and renderer; Homey does not expose that renderer, WebCodecs, or FFmpeg to apps. Shipping a live-snapshot action therefore requires a reviewed Homey-compatible native or WebAssembly decoder, bounded CPU/memory use, dependency and license review, and tests on the Homey Pro runtime. The repository intentionally does not pretend that the saved-inbox action captures a fresh live frame.

## Other Android feature evidence

The current bundle also contains UI and transport evidence for these feature families. This is an inventory for future bounded research, not proof that every control is safe or stable enough to expose:

- Live video, audio-only monitoring, video-only monitoring, picture-in-picture, persistent/background monitoring, camera flip, and breath-rate monitoring.
- Auto/manual soothing, bounce on/off, bounce intensity, bounce timers, smart-lock behavior, sound playback, sound volume, lullaby assets, and night-light brightness.
- Baby presence, sleep/wake phase, attention state, breath-monitor state, crib mode, charging/power state, obstruction/top-arc alerts, and firmware/calibration state.
- Sleep timeline, saved inbox/video moments, caregiver and baby profiles, product education, firmware update, calibration, and wrong-status feedback flows.

This repository continues to expose verified read-only telemetry and saved media only. Android write models and MQTT topics are not sufficient by themselves to justify sending crib-control, calibration, firmware, or safety-related commands from Homey.

## Pairing implication

Account authentication and crib discovery are separate from live crib telemetry. The Android evidence and existing API behavior support listing a discovered crib even when its state, online-status, and firmware endpoints are unavailable. Homey pairing and repair therefore validate authenticated discovery only; normal polling is responsible for showing the crib as unavailable or offline afterward.

## Open questions

- The inbox service is undocumented and may change without notice.
- The ordering guarantee for `baby_notifications` is inferred from the mobile screen's use of the first page and should be rechecked after Android app updates.
- Registered app-device IDs may be rotated or removed. Inbox lookup therefore retries only IDs returned by the current account response and only after the API explicitly reports an invalid device ID.
- Media URL hostnames and expiry periods are response-dependent. Homey therefore validates each URL at use time and does not persist it.
- Live account checks were limited to read-only validation of the required `device_id` behavior, registered-device discovery, and inbox acceptance. They did not log account identifiers, payloads, or response URLs, which may contain temporary signatures.

## Refresh checklist

When a newer Android bundle is inspected, update this document in the same change that updates any derived SDK behavior:

1. Record the inspection date, app version, version code, package name, SDK levels, artifact sizes, and SHA-256 hashes.
2. Compare the base APK entry and DEX count before trusting prior extraction assumptions.
3. Recheck `/inbox/v2`, `/inbox`, `/babyProfiles/{babyId}/userDevices`, every query name, response field, device-ID source, content type, and the mobile screen's page size and ordering behavior.
4. Recompute the trusted application-configuration fingerprints if Cognito, API, or IoT values changed; do not accept a new value solely because its hostname shape looks plausible.
5. Rerun the SDK and Homey tests, regenerate the vendored SDK archive, prepare a reproducible Homey stage, and install only that verified stage.
6. Delete all downloaded bundles, extracted APKs, DEX files, decompiler output, and expiring media URLs after the non-secret findings are recorded.

## Verified crib control protocol (Android 2.57.8)

The Android 2.57.8 bundle (version code 211) confirms that current crib controls use an AWS IoT device shadow over mutual TLS. The app obtains a per-registration certificate and private key from `POST /cradles/pairedUsers/v3`, downloads the two configured S3 objects with the account's temporary AWS credentials, and publishes desired state to `$aws/things/{cradle_id}/shadow/update`.

The native soothing controls separate the visible level from its maximum:

- bounce Off uses `actuator.on = false`; visible levels 1 through 5 publish `bounceLevel` indices 0 through 4;
- sound Off uses `soundSynth.play = false`; visible levels 1 through 5 publish `musicLevel` indices 0 through 4;
- maximum bounce publishes `maxBounceLimit` as an integer percentage;
- maximum sound publishes `maxVolumeLimit` as an integer percentage;
- the crib reports dynamic `bounceLevelAmplitudes` and `musicLevelVolumes` recipes, so firmware maps each selected level under the configured maximum;
- low-level manual preview controls remain available as `actuator.amplitude` and `soundSynth.volume` from 0 through 99, preserving the remaining reported `soundSynth` fields;
- control lock uses `autoModeLockOn` and `autoModeLockDuration` from 1 through 60 minutes.

The Android dashboard passes `-1` for Off and sends indices 0 through 4 for visible levels 1 through 5. Selecting a non-Off bounce or sound level also turns that channel on; selecting Off turns only that channel off. Homey follows the same model with Off/1–5 pickers and separate percentage maximums. Its main On control reuses the saved picker selections and falls back to level 1 for both channels only when both selections are Off, ensuring On always starts soothing. All controls return after one accepted shadow update instead of polling for a second confirmation. The controller keeps one correlated response subscription for its connection, and Homey coalesces rapid level or maximum changes to the newest pending value rather than replaying every intermediate selection.

A live crib test on July 6, 2026 confirmed the current shadow protocol. The crib was left stopped and unlocked. Calibration, obstruction handling, firmware operations, and other service controls remain outside the supported surface.
