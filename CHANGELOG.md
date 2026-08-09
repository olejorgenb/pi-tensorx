# Changelog

## Unreleased

### Fixed

- Catalog fetches now have a per-attempt timeout and retry transient failures (network errors, timeouts, HTTP 429/5xx, invalid responses) with backoff. Previously a single failed fetch left the provider without models for the rest of the session.
- The last successfully loaded catalog is persisted in pi's provider store and restored at startup, so TensorX models remain selectable even when the API is unreachable — the cached catalog is visible in the model picker immediately, while a catalog refresh is still running.
- The catalog now refreshes with the API key saved via `/login` in interactive sessions; previously the live catalog only loaded when `TENSORX_API_KEY` was set in the environment.
- The startup pre-fetch uses a reduced timeout/retry budget so a hanging API cannot block extension load for long.

## 1.0.0 - 2026-06-28

Initial release.

- Registers TensorX as a pi provider.
- Fetches the TensorX model catalog (`GET /v1/model/info`) on startup when `TENSORX_API_KEY` is set, and falls back to a bundled catalog snapshot otherwise so the provider still appears under `/login` → API Keys.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `TENSORX_API_KEY` environment variable.
- Adds `/tensorx-models` to list available TensorX models.
