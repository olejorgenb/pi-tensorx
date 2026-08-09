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

A key saved through `/login` is enough to keep the catalog current: pi passes it to the extension's `refreshModels()` hook when it refreshes model lists. `TENSORX_API_KEY` still works — pi's API-key resolution falls back to it, and it is also what lets the catalog load during the very first startup, before any key is saved.

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

At load the extension registers whatever it can reach on its own: the live catalog if `TENSORX_API_KEY` is in the environment, the bundled snapshot otherwise. At that point the extension is being constructed and has no session context to resolve a saved credential from, so the environment is the only key source available. That startup fetch is given a 5-second deadline, since pi waits for extensions to finish loading; on timeout it falls back to the snapshot. The snapshot is also what lets TensorX appear under `/login` → API Keys, since pi only lists providers that have registered models.

From there pi's `refreshModels()` hook takes over. pi calls it with the effective credential — a key saved through `/login`, or `TENSORX_API_KEY`, whichever pi resolves — and replaces the registered list with what it returns. pi calls it without network access on startup and after credential changes, and with network access when you open `/model` or run `pi update --models`. A fetched catalog is persisted to pi's `models-store.json` via `context.publish({ persist })`, so later sessions start from the live catalog rather than the snapshot.

This matters because the catalog is the source of truth for model IDs: TensorX renames and retires models, and a stale ID fails at request time with `403 key not allowed to access model` rather than at selection time. The live catalog is also scoped to your key, so it lists only models that key may actually use.

Inference needs either a saved API key from `/login` or `TENSORX_API_KEY`.

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
