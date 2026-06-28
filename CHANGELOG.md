# Changelog

## 1.0.0 - 2026-06-28

Initial release.

- Registers TensorX as a pi provider.
- Fetches the TensorX model catalog (`GET /v1/model/info`) on startup when `TENSORX_API_KEY` is set, and falls back to a bundled catalog snapshot otherwise so the provider still appears under `/login` → API Keys.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `TENSORX_API_KEY` environment variable.
- Adds `/tensorx-models` to list available TensorX models.
