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

On load it fetches `GET https://api.tensorx.ai/v1/model/info`, keeps models with `supports_function_calling: true`, and registers them under the `tensorx` provider via `pi.registerProvider()` with the `openai-completions` adapter. Model metadata is derived from each entry's `model_info` (see `mapCatalog()`): `max_input_tokens` (falling back to `max_tokens`) becomes the context window, `max_output_tokens` becomes the max output, the `*_cost_per_token` fields become pi cost metadata (multiplied to per-million-token cost), `supports_vision` adds image input, and `supports_reasoning` marks a model as reasoning-capable. Duplicate model IDs in the catalog are de-duplicated, keeping the first.

The TensorX catalog endpoint requires an API key. Catalog fetches have a per-attempt timeout and retry transient failures (timeouts, network errors, HTTP 429/5xx, invalid responses) with backoff; permanent errors such as a bad key fail fast. When `TENSORX_API_KEY` is set, the extension pre-fetches the catalog at load — needed because pi does not refresh extension providers in non-interactive modes such as `pi --list-models`. In interactive sessions a `refreshModels` callback fetches the catalog using the effective credential (`context.credential`: a key saved via `/login` or the environment variable), keeps the last-known-good list when the fetch fails, and persists the catalog in pi's provider store via `context.publish({ persist })`; `readCachedModels()` restores it at startup, so models stay selectable while the API is unreachable. Without a key, or when the fetch fails, the extension registers `FALLBACK_CATALOG`, a bundled snapshot of the catalog held in the API's native shape and mapped by the same `mapCatalog()`. The snapshot is not just for offline use: pi lists only providers that have at least one registered model under `/login` (it reads `modelRegistry.getAll()`), so with an empty list TensorX would not appear there at all. With the snapshot, TensorX shows under `/login` → API Keys and is usable with a saved key; the saved key also refreshes the catalog after login. Regenerate the snapshot from `GET /v1/model/info` when the catalog changes. Inference uses a saved API key from `/login` or `TENSORX_API_KEY`. The extension also registers `/tensorx-models` to list the registered models.

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
