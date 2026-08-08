# Changelog

## Unreleased

- Refreshes the model catalog through pi's `refreshModels()` provider hook, which supplies the credential saved via `/login`. The catalog no longer depends on `TENSORX_API_KEY` being set in the environment, so a key saved through `/login` now keeps the model list current. Fixes 403s from stale bundled model IDs (`key not allowed to access model`) when TensorX renames or retires a model.
- Persists the fetched catalog to pi's `models-store.json`, so later sessions start from the live catalog instead of the bundled snapshot.
- `/tensorx-models` now lists the refreshed catalog rather than the list registered at load.
- Requires pi 0.84.0 or newer for the `context.stored` / `context.publish()` refresh API.

## 1.0.0 - 2026-06-28

Initial release.

- Registers TensorX as a pi provider.
- Fetches the TensorX model catalog (`GET /v1/model/info`) on startup when `TENSORX_API_KEY` is set, and falls back to a bundled catalog snapshot otherwise so the provider still appears under `/login` → API Keys.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `TENSORX_API_KEY` environment variable.
- Adds `/tensorx-models` to list available TensorX models.
