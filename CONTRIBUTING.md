# Contributing

1. Use Node.js 20.12 or newer.
2. Run `npm ci --ignore-scripts`, `npm run release:check`, and `npm run check` before opening a pull request.
3. Keep live tests read-only. Never add a state-changing endpoint without documented protocol evidence and explicit safety review.
4. Do not commit credentials, tokens, crib IDs, baby names, or captured private payloads.
5. Add unit tests for protocol parsing and mocked transports; keep real-account validation in `scripts/integration-test.ts`.
6. Keep local `.env` files owner-readable only (`chmod 600 .env` on POSIX systems).
