# Changelog

## Unreleased

- The catalog persisted to pi's `models-store.json` now carries the provider, API, and base URL fields pi's model store expects, instead of being written through an unchecked cast; restoring a stored catalog goes through the same typed shape. Requires pi 0.84.0 or newer for the `context.stored` / `context.publish()` refresh API.
- Catalog updates are applied through `context.publish({ update })`, which is generation-checked, so a superseded refresh can no longer overwrite a newer model list.
- De-duplicates model IDs that differ only in case, keeping the all-lowercase spelling, so models like `moonshotai/kimi-k2.6` no longer appear twice in the model picker.
- Warns instead of silently pricing a model at zero when the catalog reports an unparsable `*_cost_per_token` value.
- Removes the bundled catalog snapshot. It existed because pi was believed to list only providers with at least one registered model under `/login`; that is not the case in pi 0.84, so the provider now registers with the catalog persisted from an earlier session — or with no models at all — when no key is available at load, and `refreshModels()` populates it once one exists. This drops a copy of the catalog that could — and did — drift from the live pricing data.
- Explains a rate-limited request instead of dumping the raw 429 body. The extension now registers a `streamSimple` handler that wraps pi's `openai-completions` implementation with a `fetch` that rewrites a 429 into one line naming the limit that was hit, the `retry-after` delay, the reset time, and the remaining request/token headroom — none of which reached the user before, because the OpenAI SDK folds the response into an error before pi's `after_provider_response` hook can read the headers. Catalog fetches that get throttled log the same detail.

## 1.1.0 - 2026-08-09

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
