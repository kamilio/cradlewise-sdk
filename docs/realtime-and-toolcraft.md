# Realtime and Toolcraft design notes

## Current implementation status

The current Android app does **not** use Cognito IAM WebSockets for remote MQTT. Decompiled current-app code constructs `AWSIotMqttManager` with a device ID as the client ID and connects with a per-device keystore loaded from locally provisioned certificate/private-key material. The certificate bootstrap calls `POST /cradles/pairedUsers/v3`, which registers/assigns a user device and can fail with device-limit or access-state errors.

`CradlewiseController` (`src/controls.ts`) implements that verified per-device mTLS protocol for explicit control operations. An earlier Cognito IAM WebSocket transport was explored as a research-only path before the certificate requirement was identified; it was removed once confirmed incompatible with the current service (`AWS_ERROR_MQTT_UNEXPECTED_HANGUP` against a real account on both this package and `pycradlewise`). REST polling remains the supported telemetry path for crib state.

## Toolcraft streaming

Toolcraft 0.0.109 provides `defineStreamCommand` with typed event schemas, `AbortSignal` cancellation, pull-based bounded delivery, status events, secret refresh, SDK async iteration, CLI NDJSON output, explicit MCP subscribe/unsubscribe sessions, and testing-harness stream support.

Cradlewise exposes `watch` through CLI, SDK, and MCP. The command emits an immediate bounded REST snapshot and continues polling every 15–300 seconds until cancelled.

Explicit finite-command result schemas remain necessary for MCP `outputSchema` and structured content. Streaming commands instead declare an event schema that Toolcraft validates for every emitted snapshot.
