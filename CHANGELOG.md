# Changelog

## Unreleased

- Refreshes the model catalog through pi's `refreshModels()` provider hook, which supplies the credential saved via `/login`. The catalog no longer depends on `TENSORX_API_KEY` being set in the environment, so a key saved through `/login` now keeps the model list current. Fixes 403s from stale bundled model IDs (`key not allowed to access model`) when TensorX renames or retires a model.
- Persists the fetched catalog to pi's `models-store.json`, so later sessions start from the live catalog instead of the bundled snapshot.
- `/tensorx-models` now lists the refreshed catalog rather than the list registered at load.
- Bounds the startup catalog fetch with a 5-second timeout. pi waits for extensions to load, so a stalled TensorX endpoint could previously hang startup indefinitely; it now falls back to the bundled snapshot.
- De-duplicates model IDs that differ only in case, keeping the all-lowercase spelling, so models like `moonshotai/kimi-k2.6` no longer appear twice in the model picker.
- Warns instead of silently pricing a model at zero when the catalog reports an unparsable `*_cost_per_token` value.
- Removes the bundled catalog snapshot. It existed because pi was believed to list only providers with at least one registered model under `/login`; that is not the case in pi 0.84, so the provider now registers with no models when no key is available and `refreshModels()` populates the catalog once one exists. This drops a copy of the catalog that could — and did — drift from the live pricing data.
- Requires pi 0.84.0 or newer for the `context.stored` / `context.publish()` refresh API.

## 1.0.0 - 2026-06-28

Initial release.

- Registers TensorX as a pi provider.
- Fetches the TensorX model catalog (`GET /v1/model/info`) on startup when `TENSORX_API_KEY` is set, and falls back to a bundled catalog snapshot otherwise so the provider still appears under `/login` → API Keys.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `TENSORX_API_KEY` environment variable.
- Adds `/tensorx-models` to list available TensorX models.
