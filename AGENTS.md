# AGENTS.md

## Project overview

This repository is `@czottmann/pi-tensorx`, a Pi extension package that registers a `tensorx` provider for the [TensorX](https://tensorx.ai/) API (`https://api.tensorx.ai/v1`).

The extension registers the `tensorx` provider with Pi using the `openai-completions` API adapter and keeps only the tool-capable models from the TensorX catalog. It pre-fetches the catalog at load when an API key is available; when none is, it registers a bundled snapshot instead.

## Important files

- `extensions/tensorx.ts` — the extension. Fetches the catalog and registers the provider and the `/tensorx-models` command.
- `README.md` — user-facing install, auth, and usage docs.
- `CHANGELOG.md` — per-release notes, shipped in the npm package.
- `package.json` — npm package metadata, Pi manifest, scripts, peer/dev dependencies.
- `.github/workflows/publish.yml` — publishes to npm on a GitHub Release via Trusted Publishing.

## How the extension works

On load it fetches `GET https://api.tensorx.ai/v1/model/info` (on a reduced timeout/retry budget, since pi awaits the extension factory and a stalled endpoint would otherwise hang startup), keeps models with `supports_function_calling: true`, and registers them under the `tensorx` provider via `pi.registerProvider()` with the `openai-completions` adapter. Model metadata is derived from each entry's `model_info` (see `mapCatalog()`): `max_input_tokens` (falling back to `max_tokens`) becomes the context window, `max_output_tokens` becomes the max output, the `*_cost_per_token` fields become pi cost metadata (multiplied to per-million-token cost), `supports_vision` adds image input, and `supports_reasoning` marks a model as reasoning-capable. Duplicate model IDs in the catalog are de-duplicated, keeping the first; IDs that differ only in case are folded to one entry, keeping the all-lowercase spelling (the catalog has shipped both `moonshotai/Kimi-K2.6` and `moonshotai/kimi-k2.6`).

The TensorX catalog endpoint requires an API key. Catalog fetches have a per-attempt timeout and retry transient failures (timeouts, network errors, HTTP 429/5xx, invalid responses) with backoff; permanent errors such as a bad key fail fast. At load the extension is still being constructed — there is no `ctx` yet, so no session-scoped way to resolve a saved credential — and `TENSORX_API_KEY` from the environment is the only key source available: when it is set the catalog is pre-fetched on a tighter timeout/retry budget — needed because pi does not refresh extension providers in non-interactive modes such as `pi --list-models` — and otherwise `readCachedModels()` seeds the registration from the last-known-good catalog in pi's provider store. Failing both, the registration falls back to `FALLBACK_CATALOG`, a bundled snapshot of the catalog held in the API's native shape and mapped by the same `mapCatalog()`. The snapshot is not just for offline use: pi lists only providers that have at least one registered model under `/login` (it reads `modelRegistry.getAll()`), so with an empty list TensorX would not appear there at all. Keep it populated. Regenerate it from `GET /v1/model/info` when the catalog drifts far from it.

After load, the catalog comes from the `refreshModels(context)` hook passed to `pi.registerProvider()` (pi 0.84.0+). This is how the extension reaches a credential at all after load: pi passes the effective credential to the hook as `context.credential`, and the list the hook returns replaces the registered models. Note that this is a convenience, not a security boundary — extensions run in-process with full Node privileges, and a session-scoped handler can read the same key via `ctx.modelRegistry.getProviderAuth("tensorx")`. `context.credential` is already resolved, so it carries a `/login`-stored key or the `$TENSORX_API_KEY` fallback declared in the registration; do not re-read `process.env` in the hook. `context.allowNetwork` is false on startup and after credential changes, and true when the user opens `/model` or runs `pi update --models` — see `allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled` in pi's `ModelRuntime.refresh()`. Because the network-enabled calls are the rare ones, a successful fetch is persisted with `context.publish({ persist })` into pi's `models-store.json`; `context.stored` restores it on the next cold start, and `readCachedModels()` reads the same file directly at load. `currentModels` holds the list pi last accepted, and the hook returns it unchanged whenever a refresh cannot improve on it — returning a shorter list would drop models pi already offers. Both the restore from `context.stored` and the post-fetch update assign `currentModels` inside `context.publish({ update })`, never directly: publication is generation-checked, so a superseded refresh cannot overwrite a newer list.

Model IDs are the reason this matters: TensorX renames and retires models, and a stale ID surfaces as a request-time `403 key not allowed to access model` rather than a selection-time error. The live catalog is also key-scoped, so it lists only models the key may use.

Inference uses a saved API key from `/login` or `TENSORX_API_KEY`. The extension also registers `/tensorx-models`, which lists `currentModels` so it reflects refreshes.

## Development commands

```bash
npm run check          # tsc --noEmit
npm pack --dry-run     # for package/release-sensitive changes
```

`npm run build` is an alias for `tsc --noEmit`. This package ships TypeScript source loaded by pi's jiti runtime; there is no compiled `dist/`.

## Coding conventions

- TypeScript is strict, ESM, NodeNext (`tsconfig.json`).
- Keep code simple and explicit. Avoid abstractions without multiple call sites.
- Pi core imports (`@earendil-works/*`) belong in `peerDependencies` with `"*"`; pinned development versions go in `devDependencies`. Do not add runtime dependencies.

## Packaging and releases

- The package ships the source files listed in `files` (`extensions`, `README.md`, `CHANGELOG.md`), not a build. `npm` also includes `package.json` and `LICENSE.md` automatically.
- Releases run through GitHub Releases: add a `CHANGELOG.md` entry, bump the version, commit, tag `vX.Y.Z`, and create a matching GitHub Release. `publish.yml` triggers on `release: published` and runs `npm publish --provenance` via Trusted Publishing.
- Publish a given version either manually or via a GitHub Release, never both — a duplicate publish fails.

## Git hygiene

- Check `git status --short` before committing or broad edits.
- Do not overwrite unrelated user changes.
- Commit only when explicitly asked.
