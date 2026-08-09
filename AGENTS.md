# AGENTS.md

## Project overview

This repository is `@czottmann/pi-tensorx`, a Pi extension package that registers a `tensorx` provider for the [TensorX](https://tensorx.ai/) API (`https://api.tensorx.ai/v1`).

On startup the extension fetches the TensorX model catalog, keeps the tool-capable models, and registers them with Pi using the `openai-completions` API adapter. When no API key is available to fetch the catalog, it registers no models and lets Pi's `refreshModels()` hook populate them once a credential exists.

## Important files

- `extensions/tensorx.ts` — the extension. Fetches the catalog and registers the provider and the `/tensorx-models` command.
- `README.md` — user-facing install, auth, and usage docs.
- `CHANGELOG.md` — per-release notes, shipped in the npm package.
- `package.json` — npm package metadata, Pi manifest, scripts, peer/dev dependencies.
- `.github/workflows/publish.yml` — publishes to npm on a GitHub Release via Trusted Publishing.

## How the extension works

On load it fetches `GET https://api.tensorx.ai/v1/model/info` (with a 5-second deadline, since pi awaits the extension factory and a stalled endpoint would otherwise hang startup), keeps models with `supports_function_calling: true`, and registers them under the `tensorx` provider via `pi.registerProvider()` with the `openai-completions` adapter. Model metadata is derived from each entry's `model_info` (see `mapCatalog()`): `max_input_tokens` (falling back to `max_tokens`) becomes the context window, `max_output_tokens` becomes the max output, the `*_cost_per_token` fields become pi cost metadata (multiplied to per-million-token cost), `supports_vision` adds image input, and `supports_reasoning` marks a model as reasoning-capable. Duplicate model IDs in the catalog are de-duplicated, keeping the first; IDs that differ only in case are folded to one entry, keeping the all-lowercase spelling (the catalog has shipped both `moonshotai/Kimi-K2.6` and `moonshotai/kimi-k2.6`).

The TensorX catalog endpoint requires an API key. At load the extension is still being constructed — there is no `ctx` yet, so no session-scoped way to resolve a saved credential — and `TENSORX_API_KEY` from the environment is the only key source available. Without it the provider registers with an empty `models` array, and `refreshModels()` fills the catalog in once a credential exists.

Earlier versions shipped a bundled catalog snapshot (`FALLBACK_CATALOG`) on the theory that pi only lists providers with at least one registered model under `/login`. That is not true as of pi 0.84: `getLoginProviderOptions()` in `interactive-mode.ts` iterates `modelRuntime.getProviders()` and filters on `provider.auth.apiKey` / `provider.auth.oauth` only, with no model-count check, and `registerProvider()` accepts an empty `models` array. Verified end to end against 0.84.1 with an emptied snapshot: TensorX still appears under `/login` → API Keys, and the catalog populates a moment after the key is saved, because the login flow fires a networked `refresh({ providers: [providerId] })`. The snapshot was therefore removed — it had already drifted from the live catalog (it claimed a `cache_creation_input_token_cost` for `deepseek/deepseek-r1-0528` that the API reports as `null`).

Note that `GET /v1/model/info` is undocumented. TensorX's public docs cover `GET /v1/models`, which returns only `id`/`object`/`created`/`owned_by` and none of the cost or capability metadata this extension needs. `/model/info` is LiteLLM proxy's built-in route — the response carries LiteLLM's schema (`supported_openai_params`, `mode`, `supports_assistant_prefill`) — so treat it as something that can change without notice. Failure is quiet: `fetchModels()` warns to the console and the catalog stays as-is.

After load, the catalog comes from the `refreshModels(context)` hook passed to `pi.registerProvider()` (pi 0.84.0+). This is how the extension reaches a credential at all after load: pi passes the effective credential to the hook as `context.credential`, and the list the hook returns replaces the registered models. Note that this is a convenience, not a security boundary — extensions run in-process with full Node privileges, and a session-scoped handler can read the same key via `ctx.modelRegistry.getProviderAuth("tensorx")`. `context.credential` is already resolved, so it carries a `/login`-stored key or the `$TENSORX_API_KEY` fallback declared in the registration; do not re-read `process.env` in the hook. `context.allowNetwork` is false on startup and during the credential-sync refresh, and true when the user opens `/model`, runs `pi update --models`, or completes a `/login` (which fires its own networked refresh for the provider afterwards) — see `allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled` in pi's `ModelRuntime.refresh()`. Because the network-enabled calls are the rare ones, a successful fetch is persisted with `context.publish({ persist })` into pi's `models-store.json`; `context.stored` restores it on the next cold start. `currentModels` holds the list pi last accepted, and the hook returns it unchanged whenever a refresh cannot improve on it — returning a shorter list would drop models pi already offers. Both the restore from `context.stored` and the post-fetch update assign `currentModels` inside `context.publish({ update })`, never directly: publication is generation-checked, so a superseded refresh cannot overwrite a newer list.

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
