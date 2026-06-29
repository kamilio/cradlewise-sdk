# Realtime and Toolcraft design notes

## Current implementation status

The current Android app does **not** use Cognito IAM WebSockets for remote MQTT. Decompiled current-app code constructs `AWSIotMqttManager` with a device ID as the client ID and connects with a per-device keystore loaded from locally provisioned certificate/private-key material. The certificate bootstrap calls `POST /cradles/pairedUsers/v3`, which registers/assigns a user device and can fail with device-limit or access-state errors.

Because that bootstrap changes account/device state and can consume a device slot, this read-only package does not call it. `CradlewiseRealtime` retains the older IAM WebSocket implementation only as a research/legacy transport and requires explicit `allowLegacyIamAuthentication: true`. It:

1. Connects over signed WebSockets to the IoT endpoint extracted from the Android app.
2. Subscribes to `$aws/things/{id}/shadow/get/accepted`.
3. Subscribes to `$aws/things/{id}/shadow/update/delta`.
4. Subscribes to `{id}/cradle_state`.
5. Publishes a shadow `get` request for initial state.
6. Merges partial updates into an optional `CradlewiseClient` model cache.
7. Reconnects before the temporary AWS credentials expire.
8. Contains consumer listener failures and reports them through `messageError`.
9. Shares `operationTimeoutMs` across initial SDK loading, credential acquisition, connection, and subscription setup, then applies it to each later MQTT operation.
10. Cleans up connections and subscriptions that settle after their deadline.
11. Rejects credentials inside the configured refresh window before constructing the MQTT SDK provider.
12. Caps subscriptions at 100 crib IDs and preflights payload depth and value counts before JSON parsing.

The REST client is production-ready relative to the known private API. The legacy transport is not current-service compatible. During development on July 4, 2026, Cognito and REST calls succeeded with a real account, while both this package and `pycradlewise` received `AWS_ERROR_MQTT_UNEXPECTED_HANGUP` using IAM WebSockets. The certificate-based app implementation explains that rejection.

## Requirements for supported realtime

- Design an explicit, user-approved device-registration API with clear device-slot and revocation semantics.
- Store the returned private key and certificate with operating-system-backed secret protection and mode-restricted fallback files.
- Use an mTLS MQTT builder and the assigned device ID as the client ID.
- Verify certificate rotation, device removal, topic authorization, and account logout cleanup.
- Add packet-level fixtures and a dedicated opt-in live test before enabling certificate realtime by default.

## Toolcraft streaming

Toolcraft 0.0.109 provides `defineStreamCommand` with typed event schemas, `AbortSignal` cancellation, pull-based bounded delivery, status events, secret refresh, SDK async iteration, CLI NDJSON output, explicit MCP subscribe/unsubscribe sessions, and testing-harness stream support.

Cradlewise now exposes `watch` through CLI, SDK, and MCP. The command emits an immediate bounded REST snapshot and continues polling every 15–300 seconds until cancelled. REST polling is intentional: the legacy `CradlewiseRealtime` IAM WebSocket implementation remains incompatible with the current certificate-based mobile protocol and is not used by the Toolcraft stream.

Explicit finite-command result schemas remain necessary for MCP `outputSchema` and structured content. Streaming commands instead declare an event schema that Toolcraft validates for every emitted snapshot.
