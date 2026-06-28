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

Note: the live catalog endpoint requires a key, and pi does not hand the `/login`-stored key to extensions. So the up-to-date catalog only loads when `TENSORX_API_KEY` is set in your environment. Without it, the extension registers a bundled snapshot of the catalog — enough to log in via `/login` and use the models. Set `TENSORX_API_KEY` if you want the current catalog instead of the snapshot.

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

On startup, the extension fetches `GET https://api.tensorx.ai/v1/model/info`, keeps models that report `supports_function_calling`, and registers them with `pi.registerProvider()` using pi's `openai-completions` API adapter.

Model metadata comes from each entry's `model_info`:

- `max_input_tokens` (or `max_tokens`) becomes pi's context window.
- `max_output_tokens` becomes the max output.
- `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, and `cache_creation_input_token_cost` become pi cost metadata, converted to per-million-token cost.
- `supports_vision` adds image input.
- `supports_reasoning` marks a model as reasoning-capable.

Duplicate model IDs in the catalog are de-duplicated, keeping the first.

If `TENSORX_API_KEY` is not in the environment, the extension can't reach the catalog endpoint, so it registers a bundled snapshot of the catalog instead. The snapshot is what lets TensorX appear under `/login` → API Keys: pi only lists providers that have registered models. Inference needs either a saved API key from `/login` or `TENSORX_API_KEY`.

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
