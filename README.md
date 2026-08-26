# @czottmann/pi-tensorx

TensorX provider extension for [pi](https://pi.dev). It registers tool-capable [TensorX](https://tensorx.ai/) models under the `tensorx` provider.

## Install

From npm:

```bash
pi install npm:@czottmann/pi-tensorx
```

From a local checkout:

```bash
cd path/to/pi-tensorx
npm install
pi install "$PWD"
```

## Set up auth

Use pi's API-key flow:

```bash
pi
/login
# Choose "Use an API key", then "TensorX".
```

Or set an environment variable before starting pi:

```bash
export TENSORX_API_KEY=your-key-here
```

TensorX uses static API keys, so it appears under API keys in `/login`, not under subscriptions.

A key saved through `/login` is enough to keep the catalog current: pi passes it to the extension's `refreshModels()` hook when it refreshes model lists — no restart needed. `TENSORX_API_KEY` still works — pi's API-key resolution falls back to it — and it is what lets the catalog load during the very first startup, before any key is saved, or in non-interactive modes (`pi --list-models` does not refresh catalogs). Without any key, the extension registers whatever catalog was persisted from an earlier session, or no models at all on a fresh install — either way TensorX is still listed under `/login`, and the catalog fills in once a key is saved.

## Use

List registered models:

```bash
pi --list-models | grep tensorx
```

Start pi with TensorX:

```bash
pi --provider tensorx
```

In interactive mode, `/tensorx-models` lists the TensorX models registered by the extension.

## How it works

The extension registers the `tensorx` provider with `pi.registerProvider()` using pi's `openai-completions` API adapter, and keeps only models that report `supports_function_calling`. The model list comes from `GET https://api.tensorx.ai/v1/model/info` whenever an API key is available; see below for when that is.

Model metadata comes from each entry's `model_info`:

- `max_input_tokens` (or `max_tokens`) becomes pi's context window.
- `max_output_tokens` becomes the max output.
- `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, and `cache_creation_input_token_cost` become pi cost metadata, converted to per-million-token cost.
- `supports_vision` adds image input.
- `supports_reasoning` marks a model as reasoning-capable.

Duplicate model IDs in the catalog are de-duplicated, keeping the first. IDs that differ only in case are treated as the same model, keeping the all-lowercase spelling.

Fetches have a per-attempt timeout and retry transient failures (network errors, timeouts, HTTP 429/5xx, invalid responses) with backoff. At load the extension fetches the catalog only if `TENSORX_API_KEY` is in the environment. At that point the extension is being constructed and has no session context to resolve a saved credential from, so the environment is the only key source available. That startup fetch runs on a reduced timeout and retry budget, since pi waits for extensions to finish loading before it builds the UI. With no key — or when the fetch fails — the extension registers the last catalog persisted from an earlier session, and failing that no models at all, which is fine: pi lists the provider under `/login` → API Keys based on its auth configuration alone.

From there pi's `refreshModels()` hook takes over. pi calls it with the effective credential — a key saved through `/login`, or `TENSORX_API_KEY`, whichever pi resolves — and replaces the registered list with what it returns. pi calls it without network access on startup and after credential changes, and with network access when you open `/model`, run `pi update --models`, or immediately after saving a key through `/login`. A fetched catalog is persisted to pi's `models-store.json` via `context.publish({ persist })`, so later sessions start from the stored catalog rather than empty, and models stay selectable even when the API is unreachable. Note that non-interactive runs (`pi --list-models`) do not refresh provider catalogs, so in those modes models come from the `TENSORX_API_KEY` pre-fetch or the persisted catalog.

So a fresh install with no key registers zero models, and the catalog appears a moment after you log in.

This matters because the catalog is the source of truth for model IDs: TensorX renames and retires models, and a stale ID fails at request time with `403 key not allowed to access model` rather than at selection time. The live catalog is also scoped to your key, so it lists only models that key may actually use.

Inference needs either a saved API key from `/login` or `TENSORX_API_KEY`.

### Rate limits

TensorX throttles per API key (60 requests/minute and 2M tokens/minute by default, rising with spend — see [the rate limit docs](https://docs.tensorx.ai/api-reference/rate-limits)). A throttled request would otherwise surface as `429: {"message":"Rate limit exceeded. Please slow down and retry.", ...}`, dumping the raw response body while dropping the `retry-after` and `x-ratelimit-*` headers that say when to try again — pi's provider adapter never sees them, because the OpenAI SDK raises the error before pi's response hook runs.

The extension therefore wraps the provider's HTTP calls and rewrites a 429 into a single line:

```
429 TensorX rate limit exceeded (requests per minute); retry after 12s; resets 2026-08-26T20:15:00Z; 0/60 requests left; 1980000/2000000 tokens left. Limits scale with spend: https://docs.tensorx.ai/api-reference/rate-limits — TensorX said: Rate limit exceeded. Please slow down and retry.
```

Every part except the first is optional and appears only when TensorX sends the matching header or the `reason` field. pi still retries a throttled turn on its own (three attempts, 2s/4s/8s apart, configurable via `retry.maxRetries` and `retry.baseDelayMs` in pi's settings). Setting `retry.provider.maxRetries` above `0` adds SDK-level retries that honor the `retry-after` header, at the cost of pi seeing the error later.

## Development

```bash
npm run check
npm run build
pi -e . --provider tensorx
```

## Publishing

GitHub Actions publishes the package to npm when a GitHub Release is published. The release tag must match `package.json` exactly, with or without a leading `v` (`v1.0.0` and `1.0.0` both work for version `1.0.0`).

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@czottmann
