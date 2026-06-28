# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses semantic versioning.

## [Unreleased]

### Changed

- Harden date reads against mutation of `Function.prototype.call` and `Date.prototype.getTime` after module initialization.
- Terminate POSIX validation, reproducibility, staging, and SDK-vendoring subprocess groups on timeout or output overflow so inherited descendants cannot survive a failed command.
- Treat forwarded terminal signals as command failures even when the child exits zero, preventing interrupted build and vendoring workflows from continuing.
- Apply the same interrupted-command semantics and process-group termination to approved Homey run/install children and packaged MCP smoke checks.
- Run SDK-vendoring npm commands with the reviewed Homey child environment so account credentials, `NODE_OPTIONS`, loader hooks, and unrelated tokens are not inherited.
- Apply the same reviewed environment boundary to package, declaration, ATTW, CLI, MCP, and reproducibility smoke subprocesses while preserving only explicit redaction-test credentials.
- Continue scanning Android DEX content past region-valid but untrusted IoT endpoint decoys until the pinned trusted endpoint is found.
- Bound region-valid IoT endpoint candidates during DEX scanning to prevent crafted app bundles from causing unbounded fingerprint work.
- Stop DEX decompression immediately after the trusted IoT endpoint is found so corrupt or oversized irrelevant trailing entries cannot invalidate a successful match.
- Revalidate cached configuration file identity, permissions, size, and timestamps after reading, rejecting path swaps or in-place changes before cached secrets are accepted.
- Cancel non-streaming XAPK response bodies when array-buffer spooling exceeds its deadline.
- Keep crib discovery transactional by deferring updates to existing models until every profile and crib record has validated.
- Remove extracted ZIP outputs when their final file close fails, preserving close and removal errors instead of leaving an ambiguous artifact behind.
- Restrict inherited locale variables to the standard `LC_*` names so locale-shaped secret variables cannot cross reviewed subprocess boundaries.
- Include permission mode in verified Homey file and directory identity checks so mode changes during inspection invalidate the artifact.
- Allow Homey pairing and repair to authenticate and discover account cribs while live crib telemetry is offline, and distinguish invalid credentials from configuration, timeout, and post-login discovery failures.
- Keep verified replacement credentials when Homey repair reaches an offline crib, release the stale authenticated client, and retry the new account on the normal polling schedule.
- Keep generic authentication transport failures distinct from rejected credentials so Homey suggests checking connectivity instead of reporting a false password error.
- Strip upstream error causes from Homey pairing and repair rejections so hidden response data cannot be serialized by the pairing UI or platform logs.
- Apply the same credential-versus-operational error classification to Homey repair, including missing cribs and reconnect failures, while keeping the repair queue usable after an error.
- Surface actionable Homey messages for Cognito password-reset, unconfirmed-account, and rate-limit states instead of collapsing them into invalid credentials.
- Serialize authenticated Homey photo metadata lookup with reconnect work so credential cleanup cannot interrupt an in-flight photo request.
- Serialize the complete Homey photo action with connection changes, and clear registered images whenever credentials or clients are replaced so a prior account's temporary media selection cannot survive repair or reconnect.
- Preserve a freshly returned Homey photo token when normal polling restores a previously absent client, preventing same-account offline recovery from invalidating the next image-consuming Flow card.
- Unregister stale Homey image resources after a definitive no-photo response while preserving the last valid image across transient lookup failures.
- Return fixed cause-free validation errors for malformed Homey login, settings, and device descriptors so hostile platform accessors cannot attach private diagnostic details.
- Use captured collection and string intrinsics for Homey Cognito classification and media URL/MIME checks so later prototype replacement cannot disable login messaging or local-network photo rejection.
- Bound Homey photo response fragmentation as well as total bytes so tiny-chunk streams cannot consume unbounded memory.
- Make the credentialed Homey integration check pass on authenticated crib discovery even when every live crib-state endpoint is offline.
- Make the root credentialed integration check treat authenticated discovery as the baseline and validate live status, history, and analytics only when each source is currently readable.
- Supply `/inbox/v2` with an existing registered app-device ID discovered through the read-only `userDevices` endpoint, retrying only explicitly stale IDs and never provisioning a new device.
- Prefer the most recently connected registered app device for inbox reads while preserving stable service order when connection timestamps are unavailable.
- Reject implausibly large declared `userDevices` counts before inbox device IDs are accepted, keeping response validation within the same bounded record budget.
- Replace Homey photo-lookup failures with a fixed Flow error so malformed account responses cannot expose caregiver metadata or signed media URLs.
- Keep `CradlewiseApiError.responseBody` available for explicit debugging but make it non-enumerable so ordinary error serialization does not include private payloads or signed media URLs.
- Give Homey photo Flows a fixed actionable message when the account has no existing official-app device registration, without exposing upstream response details.
- Treat null or omitted `userDevices` lists as an empty registration set so accounts without a mobile registration reach the actionable Homey photo guidance instead of a generic response error.
- Accept Android's recognized empty inbox envelope fields when both notification arrays are omitted, while continuing to reject unrelated successful response objects.
- Validate Android's nested `enable_red_dot`, `all_tags`, and `eol_message` group objects and expose their exact boolean, string-list, and string member types.
- Expose and validate the complete Android inbox message schema, including notification IDs, priorities, aspect ratios, external actions, read/starred flags, and status.
- Reject arbitrary successful `userDevices` objects that contain neither a device list nor a recognized count field instead of misclassifying them as an empty registration.
- Contain hostile Homey photo response, header, body, and reader descriptors behind fixed cause-free errors so platform diagnostics cannot leak signed media details.
- Align Homey pairing's discovery cap with the SDK's validated 100-crib limit instead of rejecting otherwise valid accounts at 65 cribs.
- Align Homey's crib-identifier bound with the SDK's 256-byte model and request limit so corrupt legacy device data fails before cloud access.
- Normalize trailing-dot photo hostnames before local-host checks so DNS-equivalent `localhost.` and `.local.` targets cannot bypass Homey's media SSRF boundary.
- Reject single-label and common special-use local DNS names for Homey media so resolver search domains cannot turn a backend URL into a local-network request.
- Coalesce concurrent Homey photo actions and unregister their shared image during device teardown to avoid duplicate registrations and leaked image resources.
- Document offline pairing and the Advanced Flow image-token workflow, including that it retrieves saved inbox media rather than a live camera stream.
- Select the latest saved crib photo by validated message timestamp instead of relying solely on inbox response order.
- Enforce Homey's documented 5 MB image limit as exactly 5,000,000 bytes rather than the larger 5 MiB binary unit.
- Strip upstream media-fetch causes from Homey photo failures so signed temporary URLs cannot leak through diagnostics.
- Validate JPEG, PNG, and WebP byte signatures before exposing downloaded media to Homey, and keep oversize errors deterministic when stream cancellation fails.
- Drop temporary signed photo metadata when Homey cannot update its image token instead of retaining a failed media URL until the next action or teardown.
- Add bounded `/inbox/v2` photo discovery and a Homey Advanced Flow image token that remains usable when the crib itself is offline.

### Added

- Document the inspected Android 2.57.8 XAPK, hashes, inbox routes, query parameters, media fields, and repository mapping in `docs/android-bundle-notes.md`.

- A Homey SDK v3 local app under `packages/homey-app` with Compose manifests, original store assets, read-only crib sensor capabilities, account pairing and repair, bounded polling, Flow conditions, and manual refresh.
- Store-facing description explicitly identifies the integration as unofficial and read-only.
- Add a store-facing disclaimer that the unofficial integration is not a safety-critical baby monitor or a replacement for the official Cradlewise app.
- Align the plain-text Homey Store readme with the concise one-to-two-paragraph guideline and render distinct, reproducible white-background driver artwork at every required resolution.
- Bind every committed driver-image checksum to reviewed bytes and regenerate the small image in tests to prove the deterministic artwork source remains synchronized.
- Replace the capability-list store tagline with a short, user-focused read-only crib-insights description.
- Refined the monochrome launcher icon so the moon remains visually separate from the crib rail and matches the store/device artwork composition.
- Parse every Homey PNG asset chunk-by-chunk in regression tests, rejecting text, compressed-text, international-text, EXIF, truncated chunks, missing terminators, and trailing data.
- Clarified repair, account credential, and manual-refresh wording across pairing, settings, and Flow metadata.
- Clarified that the repository's `homey:install` and `homey:verify` commands are local package workflows and never install to, contact, or publish through a selected Homey.
- Added `homey:prepare` as the preferred unambiguous alias for the reference-compatible local `homey:install` workflow.
- Disabled dependency lifecycle scripts in the reference-compatible `homey:install`/`homey:prepare` path, matching the clean-install and verification workflow already proven to build the exact artifact.
- Hardened Homey SDK vendoring with import-safe transaction helpers, a workspace-exclusive transaction lock, random exclusive temporary tarballs, semantic-version filename checks, a 16 MiB archive ceiling, and concurrency/link-precreation regression tests.
- Preserve both vendoring failures and temporary workspace/tarball cleanup failures instead of allowing `finally` cleanup to mask the primary transaction error.
- Make vendoring rollback attempt every package, lockfile, archive, and dependency-tree restoration step, and surface a failed reinstall together with all other rollback failures instead of accepting a potentially inconsistent local tree.
- Make large streamed configuration-response spill cleanup fail closed, retaining the operation failure plus every file-close and temporary-directory removal failure.
- Remove every configuration-test workspace after each case; repeated suites no longer accumulate thousands of `cradlewise-test-*` directories in the operating-system temp area.
- Remove every streaming-ZIP test workspace after each case instead of accumulating `cradlewise-zip-test-*` directories across repeated runs.
- Validate retained `main`, `module`, and exact runtime `exports` targets in the built artifact, then construct the vendored SDK's configuration, authentication, and client classes with network-disabled synthetic inputs under the Homey Node runtime.
- Verify that the built SDK still exposes its realtime API surface, reports the intentionally unsupported modern transport unavailable, and safely probes the environment-dependent legacy optional transport under Homey Node 22.
- Lock the vendored authentication cleanup contract as synchronous so Homey pairing, reconnect, and teardown cannot silently leave an awaited credential-release operation behind.
- Compare bounded values from every credential-shaped local environment variable against every built-artifact file, not only the two Cradlewise login variables.
- Exclude netrc, cloud/SSH/GnuPG credential directories, and common private-key filenames in `.homeyignore` as defense in depth for direct developer builds.
- Exclude and reject macOS `.DS_Store`, AppleDouble `._*`, and `__MACOSX` metadata so filesystem provenance cannot become Homey archive content.
- Reject decomposed Unicode artifact and archive paths, keeping filenames NFC-normalized across macOS and Linux filesystems.
- Restrict every spawned Homey CLI build, validation, packing, and contact process to a minimal reviewed operating-system environment, force headless/no-notifier behavior, and allow only the final approved contact child to additionally receive `HOMEY_PAT`; runner-path, alternate-home, discovery, endpoint, client-secret, proxy, Node/OpenSSL startup, dynamic-loader, and every other unreviewed override is stripped.
- Canonicalize reviewed Windows child-process system variables such as `Path` and `SystemRoot`, reject ambiguous case variants, and keep the Homey personal-access-token name spelling-exact.
- Forward guarded-launch termination signals to the entire detached Homey CLI process group on POSIX, including bounded `SIGKILL` escalation, so runner descendants cannot outlive private-snapshot cleanup.
- Mirror credential-store, npmrc, and private-key exclusions in the repository `.gitignore` to prevent accidental source staging.
- Expanded `verify:runtime` from a Node-version check into a vendored-SDK trust gate that verifies archive SRI/lockfile binding, installed package identity, exact core JavaScript file membership, and byte equality with the root build before Homey preprocessing.
- Added non-optional npm registry signature verification to SDK, Homey CI, and tagged-release jobs; the current closures verify 390 and 452 signed packages respectively while intentionally omitting the pruned optional Toolcraft bundle.
- Pin CI, Homey-runtime, and release jobs to the exact Node.js 20.12.2, 22.22.0, and 24.14.0 patch releases used by the local compatibility matrix.
- Pin CI and release runners to Ubuntu 24.04 rather than the moving `ubuntu-latest` label.
- Make first-publish detection accept only npm's explicit `E404` package-absence response; registry outages, malformed responses, and other lookup failures now stop the release.
- Require every publishable production dependency to carry an official npm registry URL and SHA-512 lockfile integrity, except members already bound to a byte-reviewed bundled parent archive.
- Regression-check root and Homey development dependency lockfiles for official npm registry sources and SHA-512 integrity, allowing only the separately verified vendored SDK archive and reviewed Toolcraft bundle members.
- Download the exact npm 11.18.0 trusted-publishing archive into a private release workspace, verify its pinned SHA-512 SRI, and only then install it globally; repeat the check after switching back from Homey Node 22.
- Verify reviewed release archives through a reusable 64 MiB-bounded, no-follow, single-link file-handle reader that detects identity changes and preserves simultaneous verification/close failures.
- Strip unrelated account, package-registry, source-control, cloud, and AI-provider credential variables from the guarded Homey command child while preserving Homey session and ordinary system variables.
- Forward terminal hangups as well as interrupt and termination signals to guarded Homey children, then remove every installed signal listener when the child settles.
- Start guarded Homey children with the verified private execution snapshot as their working directory instead of leaving relative operations rooted in the source repository.
- Escalate repeated termination requests immediately and unresponsive guarded Homey children after five seconds, preventing a stuck child from retaining its private execution snapshot indefinitely.
- Added a local-only `homey:stage` workflow that independently rebuilds and prunes the Homey app, validates both source and copied trees, permits only relative dependency links contained by `node_modules` and resolving to single-link regular files, proves full digest equality, round-trips the exact pinned-CLI archive, and publishes the artifact plus its canonical sibling record as one identity-checked rollback transaction.
- Bound guarded Homey run/install commands to a three-way digest match between the current reviewed `.homeybuild`, the mode-restricted verification record, and the staged tree before exact CLI archive verification or device contact.
- Required the guarded launcher to read the exact canonical verification-record bytes produced by staging, rejecting semantically equivalent JSON with extra fields, reordered keys, or alternate encoding.
- Pinned the installed `homey@4.3.1` package itself to a reviewed full-tree digest covering 108 files and 761,815 bytes before any build, pack, or approved device-contact path can load its runtime modules.
- Replaced the shared fixed Homey discovery-cache filename with a fresh random mode-restricted temporary directory for every discovery transaction, remove the whole directory afterward, and fail closed while preserving both discovery and cleanup errors if removal cannot complete.
- Run guarded Homey device commands from a private disposable snapshot whose digest, smoke scan, and exact pinned-CLI archive are reverified after copying, closing the stage-mutation window between approval checks and runtime loading.
- Execute approved Homey contact in a signal-aware child process while the parent owns snapshot cleanup, and convert Homey CLI 4.3.1's implicit zero-code installation abort into a real command failure.
- Added contact-free orchestration tests proving run snapshots remain present until the remote command settles, installs use the selected Homey with the same verified path, cleanup always runs, and simultaneous runtime/cleanup failures remain inspectable.
- Added a guarded Homey stage launcher that refuses device contact without an explicit approval flag and repeats smoke, tree-digest, and CLI-pack verification immediately before an approved run or install.
- Added the isolated Homey stage and pinned-CLI archive round-trip to both CI and tagged-release verification, keeping automated deployment checks aligned with the documented local workflow.
- Added a contact-free prepared-stage verifier to CI and tagged release that creates the private execution snapshot, independently repeats the child-equivalent trust checks, and removes the snapshot before any Homey API lookup.
- Make the normal local `homey:stage` workflow run the same contact-free private-snapshot verifier automatically after transactional publication.
- Resolve the nearest existing stage-path ancestor before directory creation and recheck the canonical destination, preventing symlinked parents from redirecting staging into the source app.
- Added a runtime source regression that rejects unused baby-profile persistence, device store writes, console output, and direct Homey logger calls.
- Transactional vendoring of the packed SDK into the Homey package, Node 24 runtime enforcement, generated-manifest drift detection, built-runtime smoke testing, and a credential-gated live Homey integration check.
- A bounded streaming ZIP reader for Android configuration discovery, including central-directory validation, CRC verification, safe stored/deflated entry extraction, and nested XAPK/APK processing without loading either archive into memory.
- Homey connectivity monitoring through the standard `alarm_connectivity` capability and Insights history for sleep, activity, power, light, sound, and percentage status.
- Device-scoped Homey Flow triggers for every monitored custom capability, using Homey's automatic custom-capability trigger IDs and typed value tokens for changed enum, string, and percentage states.
- Driver-scoped automatic Flow cards with clear titles for baby presence, attention, crib connectivity, and battery changes instead of relying only on Homey's generic built-in wording.
- Bounded Homey validation, reproducibility, and SDK-vendoring subprocesses plus explicit root and Homey npm-audit gates in CI and release workflows.
- A reproducible Homey staging size gate capped at 20,000 regular files and 64 MiB to detect accidental dependency or artifact bloat.
- Generated-manifest contracts for custom capability uniqueness, percentage ranges/units, enum values, boolean change triggers, and Flow token type/example compatibility.
- A directly testable, coalescing SDK loader that evicts failed import/shape validation for retry.
- A packed core-only consumer smoke test and lockfile-driven Homey artifact pruning for the optional Toolcraft CLI/MCP dependency graph.
- Independent Node.js 22 Homey runtime tests in the tag-release workflow before returning to Node.js 24 for trusted npm publishing.
- Isolated negative fixtures for Homey artifact scanning, including sensitive files, links, native addons, install scripts, and runtime-license enforcement.
- Rejected Homey CLI `env.json` files alongside dotenv variants, credential stores, control-bearing names, and bidirectional-formatting filenames throughout source, build, stage, and archive checks.
- Added `env.json` to repository ignore policy as well as Homey packaging policy, with a regression test keeping both secret-file boundaries aligned.
- Enforced a 20,000-entry ceiling, including empty directories, before Homey pruning or staging mutations and throughout runtime, reproducibility, and exact archive scans.
- Added pre-copy Homey source limits for deceptive control/bidirectional filenames and 512 MiB total regular-file bytes, and moved the 64 MiB final-artifact byte limit into pruning's whole-tree preflight before its first deletion.
- Built-artifact content scanning for private-key blocks and common AWS, npm, GitHub, GitLab, Slack, Google, and Stripe token formats, including signatures embedded in binary files, plus rejection of credential directories and SSH key filenames.
- Exact Homey artifact comparison against ignored local `.env` values, active credential environment variables, and confidential cached Cognito identifiers without logging the matched values.
- Require local `.env` and cached configuration sources used for exact-value scanning to be single-link regular files with no group or world permission bits.
- Direct reproducibility fixtures proving creation-order independence and rejection of path, mode, content, link, root, and size-boundary changes.
- Homey production coverage gates fixed at 100% lines, 95% branches, and 95% functions, with package-metadata regression coverage preventing silent threshold drift.
- Recursive publishing-polish checks for nonempty, trimmed, bounded, control-free English manifest strings and exact Flow `titleFormatted` placeholders.

### Security

- Kept the Homey integration read-only, bounded credential and display inputs, privacy-safe availability messages, serialized cloud operations, coalesced poll callbacks, and cleared in-memory SDK credentials after scoped pairing and deletion.
- Pinned and overrode the Homey development dependency graph to zero known npm audit findings; the shipped production graph also reports zero findings.
- Reject ZIP64, multi-disk, encrypted, malformed, linked, oversized, path-confusable, and checksum-invalid Android archives before configuration data is accepted; archive opens use nonblocking preflight and post-open file-identity checks to close link and replacement races.
- Revalidate Homey-persisted app configuration against the SDK's pinned discovery fingerprint before using it, fingerprint immutable own fields rather than overridable serialization, and replace malformed or untrusted settings through fresh verified discovery.
- Require every critical SDK export to be an own data-property function before constructing credential-bearing objects, and clear authentication credentials if client construction fails after authentication succeeds.
- Journal Homey capability writes before awaiting them so rollback also restores values when Homey applies a write and then rejects its promise.
- Preflight the complete Homey artifact before any pruning, then normalize surviving regular files to `0644` and directories to `0755` through identity-checked descriptors; reject post-build mode drift during smoke validation.
- Revalidate freshly discovered Homey app configuration before authentication and persist its immutable fields directly instead of invoking an overridable serializer.
- Snapshot pairing, repair, rollback, and device settings from reviewed own data properties before asynchronous work, rejecting accessors, inherited values, duplicates, unknown keys, and later caller mutation.
- Recheck repair-session generation after settings persistence and reconnect, restoring prior credentials and connection when disconnect races either commit step.
- Dispatch Map, Array membership, and descriptor-ownership checks through captured intrinsics so overridden methods and intrinsic `.call` properties cannot alter discovery, settings, or outage handling.
- Dispatch reviewed-message and sleep-phase membership through captured Set intrinsics so prototype replacement cannot weaken Homey-facing normalization.
- Dispatch local Array append/map/slice and settings/discovery Set operations through captured intrinsics, and freeze validated credential snapshots before adapters or pairing sessions retain them.
- Require the paired crib identifier to be a reviewed own Homey data property, rejecting inherited values and accessors without invoking them.
- Publish each cloud refresh from one frozen, source-aware crib snapshot, skipping unavailable getters, rejecting malformed source lists, and rechecking crib identity after asynchronous capability writes.
- Share one bounded, unique status-source validator across pairing, repair, and device refresh so malformed cloud metadata cannot pair successfully and then fail its first reconnect.
- Retain candidate capability rollback through identity and availability checks until reconnect commit, restoring successful writes when any later publication or lifecycle step fails.
- Reject null or undefined Homey interval handles before replacing a working poll timer or publishing a candidate connection.
- Preserve the original capability-publication error even when rollback reads, writes, or logging fail, while avoiding reads for unavailable or absent capabilities.
- Treat Homey's documented `null` capability value as the unknown prior state and restore it when an initial candidate publication later fails, preventing rejected connections from leaving partial sensor state.
- Include Homey device availability in reconnect rollback, restoring prior unavailable state and safe messaging when candidate availability changes before commit.
- Retain refresh capability rollback through live identity, deletion, and availability commit; restore prior unavailability after partial Homey availability writes and count those failures consecutively.
- Read and validate Homey availability inside reconnect's sanitizing transaction, rejecting non-boolean state and containing platform getter failures before cloud work begins.
- Route driver and device error reporting through a captured non-throwing dispatcher so logger failures cannot interrupt initialization, polling, repair rollback, timer cleanup, or credential release.
- Contain app, driver, and device readiness-log failures so successful initialization is not rejected by a broken informational logger.
- Remove the exact legacy `/userdata/.cradlewise/cradlewise_app_config.json` file before Homey restores or discovers configuration, preventing an earlier development build from leaving that data web-accessible after upgrade.
- Avoid persisting unused baby profile identifiers and timezone metadata, replace unknown upstream exception text with fixed privacy-safe messages, and truncate Homey-facing Unicode without splitting surrogate pairs.
- Exclude `.env*`, npm configuration, and private-key formats from Homey staging and recursively reject any such source file that reaches the built artifact.
- Reject native addons and dependency install lifecycle scripts from the staged Homey runtime, preserving portable script-disabled deployment.
- Require every staged runtime package to have reviewed license metadata or nonempty license terms, with an exact exception only for Homey's generated runtime shim.
- Coalesce simultaneous Homey configuration loads and integrity-pin removal of the SRP helper's declaration-only runtime dependencies.
- Constrain optional-package pruning to canonical directories inside the generated build tree and reject malformed lockfile dependency maps before deletion.
- Read the pruning lockfile through a bounded no-follow descriptor with inode, link-count, timestamp, size, and UTF-8 checks, and preflight every removal before mutating the artifact.
- Hold no-follow directory descriptors across built-artifact scanning and reproducibility traversal, rejecting directory path replacement before a recursive inspection can be accepted.
- Detect in-place directory entry changes while descriptor-backed artifact inspection is active, not only complete pathname replacement.
- Preserve both the primary artifact-safety error and descriptor close failure in an `AggregateError`, while still surfacing close failures after otherwise successful inspection.
- Fail closed when Homey bootstrap or SDK XAPK workspaces cannot be removed, and retain discovery/download failures together with every cleanup failure rather than silently accepting residual files.
- Track transaction, validation, handle-close, snapshot, archive, and rollback failure state independently of rejection-value truthiness so even non-`Error` or falsy promise rejections cannot be mistaken for success.
- Install the Homey package dependency tree in the dedicated Node 22 CI runtime job before its build and smoke steps, with a workflow regression test pinning the required ordering.
- Disable lifecycle scripts while installing the exact npm CLI used for both trusted-publishing phases, with release workflow tests pinning both hardened commands.
- Centralize the Node.js 24 development-runtime gate and run it before Homey setup, verification, stage publication, stage re-verification, or guarded device commands can build, vendor, install, or inspect artifacts.
- Replace nonfunctional npm workspace examples with verified `--prefix packages/homey-app` Homey CLI commands and state package-local working directories explicitly.
- Validate the complete staged app tree, dependency tree, and declaration-removal plan before deleting optional packages or declarations, preventing partial artifact mutation when any later entry is unsafe.
- Read staged content, runtime metadata, license files, and local secret-marker sources through bounded no-follow descriptors with identity and post-read change checks; reject malformed UTF-8 in text-only sources.
- Snapshot credentials, Homey settings methods, and SDK exports before asynchronous config loading, then use intrinsic invocation and construction to prevent mid-flight replacement.
- Remove non-runtime TypeScript declarations, JavaScript source maps, `.npmignore` packaging metadata, package documentation with separate license evidence, exact-integrity-reviewed development files, app/SRP development metadata, vendored SDK source/docs and development-only package metadata, optional CLI/Toolcraft entry files, and their empty directories from Homey staging, reducing the pruned artifact to about 4.44 MB across 1,301 files.
- Rewrite staged app and integrity-pinned SRP helper metadata to runtime-only fields, replacing the removed vendor-tarball reference with the installed SDK version and dropping declaration-only dependencies so the pruned graph has no invalid or missing packages.

### Fixed

- Retain authentication deadlines explicitly instead of composing a temporary `AbortSignal.timeout()` source, preventing ignored-abort Cognito calls from hanging on the minimum supported Node.js 20 runtime.

- Preserved an existing Homey poll timer if creating its replacement fails, and made repair roll stored credentials back when settings persistence or authenticated account verification cannot be completed.
- Kept reconnect commits atomic across Homey availability and timer setup failures, and prevented deletion during capability synchronization from installing a replacement poll timer or retaining the candidate client.
- Kept the Homey connectivity alarm unchanged when the dedicated online-status endpoint is unavailable, instead of interpreting a newly discovered crib's default state as a confirmed offline result.
- Kept a Homey crib degraded when its primary state endpoint is unavailable even if auxiliary online or firmware endpoints still respond, avoiding a false fully-available status with stale sensor values.
- Preserved the prior attention alarm when the cloud supplies a mix of known-false and missing attention flags; cleared it only when every contributing flag is known false.
- Replaced unknown upstream Homey-facing and logged error messages with context-specific fixed wording, preserving only an allowlist of app-authored messages so crib IDs, account details, URLs, and response text cannot leak through exception strings.
- Contained malformed error objects whose `message` accessor throws, keeping logging and availability cleanup paths deterministic.
- Set Homey compatibility to v12.9.0 and the deployed package engine to Node.js 22, while retaining Node.js 24 solely for the current CLI toolchain.
- Stored validated SDK app configuration in private Homey ManagerSettings and limited archive bootstrap files to `/tmp`, avoiding Homey's web-exposed `/userdata` mount.
- Reduced a real forced Android configuration refresh from roughly 398 MiB peak RSS to 150 MiB by streaming downloads and nested archives, reusing buffers for stored entries, and scanning DEX data as bounded bytes instead of materializing large strings.
- Preserved the validated crib identity through pairing, connection, and refresh instead of trusting mutable cloud model fields after validation.
- Serialized poll-interval changes with reconnect/deletion work and used the safe default for corrupt stored intervals without blocking startup recovery.
- Cleared prior pairing results as soon as a newer login starts, suppressed errors from superseded discovery work, and snapshotted queued repair credentials when submitted.
- Preflighted replacement poll timers before publishing reconnect state, coalesced timer and manual Flow refresh bursts through teardown, and allowed credential repair to recover when an unrelated legacy poll value is corrupt.
- Routed Homey device uninitialization and deletion through the same idempotent timer and credential teardown.
- Cleared pairing credentials/results on session disconnect and invalidated active or queued repair attempts before they can persist cancelled credential changes.
- Rejected Flow conditions during device teardown, locked every runtime Flow card to the Cradlewise driver filter, and invoked selected device methods without trusting an overridable `.bind` property.
- Restricted Homey availability and log-safe fallback text to an explicit reviewed message set so an accidental dynamic fallback cannot disclose credentials, identifiers, URLs, tokens, or upstream payload text.
- Invoked SDK credential cleanup through intrinsic `Reflect.apply` so an overridden function `.call` cannot bypass release.

## [0.1.0] - 2026-07-04

### Added

- Cognito SRP authentication and temporary AWS credential exchange.
- Cached Android app configuration discovery.
- Signed crib discovery, state, firmware, and sleep analytics APIs.
- Configurable sleep ranges, typed current response wrappers, timezone-aware event aggregation, and partial-source analytics reporting.
- Typed crib and analytics models with defensive state snapshots and explicit partial crib-status reporting.
- Public `CradleData`, realtime event-map, and API error-option types for declaration-safe consumers.
- Research-only legacy AWS IoT transport with explicit opt-in, credential refresh, and lifecycle-safe subscriptions.
- Toolcraft CLI, SDK, and MCP read-only commands.
- Explicit Toolcraft crib and analytics output schemas for SDK and MCP introspection.
- Unit, integration, packaging, lint, formatting, and CI release checks.
- A security policy included in the published npm artifact.
- MIT-licensed Toolcraft 0.0.87 CLI, SDK, and MCP runtime.

### Security

- Enforced read-only generic requests by default; state-changing methods require explicit opt-in.
- Restricted signed REST and IoT connections to trusted Cradlewise/AWS regional hosts and rejected redirects.
- Pinned verified auto-discovered Cognito, identity, API, and IoT configuration fingerprints to prevent same-region mirror substitution.
- Made validated app configuration and auth references immutable at runtime.
- Redacted embedded Cognito identifiers and app-client secrets from config-refresh output.
- Made config-cache writes atomic and mode-restricted, and blocked prototype-altering keys throughout model state.
- Coalesced concurrent configuration extraction per cache path and rejected malformed UTF-8 in embedded or cached configuration.
- Rejected cache symlinks, hard links, non-regular files, oversized files, and foreign-owned files; removed a temporary-file chmod race.
- Added tarball path/content secret checks and a publish-time transitive production-dependency license gate.
- Added native dotenv and cached-bootstrap value scanning, and included `SECURITY.md` in the npm artifact.
- Restricted bundled-internal licensing to the exact reviewed Toolcraft tarball integrity and child-package set.
- Required installed production versions to match the lockfile and rejected empty, oversized, or symlinked license files.
- Required a structurally valid npm lockfile v3, rejected malformed package metadata and production install scripts, and ran CI/release installs with lifecycle scripts disabled.
- Pinned every direct production dependency to its reviewed exact version and made package metadata tests enforce the lockfile match.
- Excluded the unsupported legacy IoT SDK from default consumer installs.

### Fixed

- Matched the current eventsV3 and analyticsV3 contracts, including required query parameters, wrappers, and metric shapes.
- Validated malformed discovery, crib, event, metric, timezone, credential, timer, and transport inputs at runtime.
- Made duplicate discovery deterministic and raised explicit errors when all crib-status or analytics sources fail.
- Corrected open-nap range bounds, chronological ordering, negative metric handling, IANA timezone conversion, and DST elapsed durations.
- Matched Android interval semantics for sleep, awake, stirring, and away states; clipped future events and preserved `sleep_sessions_saved` soothe evidence.
- Accepted legitimate nullable current API fields while rejecting malformed dates, metrics, timezones, and noncanonical event timestamps.
- Hardened authentication retry/expiry handling, response cleanup, realtime reconnect/unsubscribe races, and stale MQTT callbacks.
- Used the earliest verifiable Cognito access/ID token expiry and prevented older reconnect intents from overriding explicit disconnects.
- Isolated returned credential snapshots, prevented superseded logins from overwriting newer state, and reconciled realtime crib mutations during connection setup and clean-session recovery.
- Bounded each complete Cognito authentication exchange with a configurable timeout and one shared abort signal.
- Made `clearCredentials()` abort an authentication exchange already in flight and destroy superseded provider state.
- Recovered concurrently re-added realtime subscriptions after late unsubscriptions and preserved present empty optional strings during model serialization.
- Prevented `clearCredentials()` from racing a shared login validity check and returning a cleared credential snapshot.
- Bounded API response bodies, spooled large APK downloads through mode-restricted temporary files, constrained APK CDN redirects, and made naive date parsing host-independent.
- Made timezone-offset parsing host-independent, restricted numeric coercion to decimal forms, and preserved computed analytics when malformed metric containers are present.
- Clipped event-derived analytics at the requested lower boundary while preserving a state already active at that boundary.
- Snapshotted validated REST host, Cognito region, account identifier, and realtime region at construction so later adapter mutation cannot redirect signed requests.
- Snapshotted public constructor, request, response, authentication, analytics, and realtime adapter fields before validation or use, preventing accessor-driven time-of-check/time-of-use changes.
- Hard-capped cache reads after metadata validation and restricted cross-platform cleanup to safe local artifact basenames.
- Treated malformed and non-object cache JSON as a recoverable miss, isolated realtime listener exceptions, and enforced partial-result invariants in public models.
- Enforced hard authentication, total REST-attempt, bootstrap, and legacy MQTT deadlines even when custom adapters ignore abort signals, and canceled late response bodies.
- Shared one REST deadline across authorization retries and made response/stream cancellation best-effort so untrusted cleanup promises cannot hang callers.
- Rejected successful HTTP error envelopes, malformed UTF-8, unsafe display strings, malformed online-state messages, unsafe event numbers, oversized configuration, credential, and signing inputs, and analytics requests for cribs without a baby identifier.
- Rejected non-finite, excessively nested, or excessive-cardinality API and MQTT JSON before model delivery, and revalidated mutable model fields during serialization.
- Bounded aggregate model text, challenge parameters, status timelines, online-state messages, and analytics metric containers, and rejected ambiguous base APK/config entries during discovery.
- Coalesced discovery, preserved existing crib models across metadata refreshes, and prevented stale concurrent crib updates or analytics requests from overwriting newer cached data.
- Bounded discovery cardinality and fanout, Toolcraft status fanout, realtime subscription counts, cache paths, request bodies, and credential/session material.
- Made crib state reads defensive snapshots, kept identifiers immutable, and derived partial flags from private validated source lists.
- Rejected encoded path traversal/separators, malformed UTF-8 and double-encoding, prototype-sensitive query names, control-bearing cache paths, and malformed analytics options before authentication.
- Enforced per-file coverage floors and production lint rules against explicit `any`, unsafe `any` propagation, and non-null assertions.
- Made JSON object declarations compatible with strict consumers that disable `exactOptionalPropertyTypes`, and added a declaration smoke gate with library checking enabled.
- Made archive cleanup non-recursive for `.tgz` paths and verified decompressed APK content against actual byte limits as well as archive metadata.
- Made cleanup preflight every archive-named artifact before deleting anything, and bounded package smoke/build subprocess runtime and output.
- Added cross-runtime, shuffled/shared-process, packed-consumer, CLI/MCP, publish-dry-run, and live read-only verification.
