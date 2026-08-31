import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "tensorx";
const PROVIDER_DISPLAY_NAME = "TensorX";
const BASE_URL = "https://api.tensorx.ai/v1";
const PROVIDER_API = "openai-completions";
const API_KEY_ENV_VAR = "TENSORX_API_KEY";
const API_KEY_ENV_REF = `$${API_KEY_ENV_VAR}`;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
// TensorX reports costs per token; pi expects cost per million tokens.
const COST_PER_MILLION = 1_000_000;
const RATE_LIMIT_DOCS_URL = "https://docs.tensorx.ai/api-reference/rate-limits";
// The `reason` field of a 429 body names the limit that was hit.
const RATE_LIMIT_REASONS: Record<string, string> = {
	rate_limit_requests: "requests per minute",
	rate_limit_tokens: "tokens per minute",
	rate_limit_concurrent: "concurrent requests",
};

// The TensorX catalog endpoint is not always reliable (timeouts, 5xx, rate
// limits), so catalog fetches get a per-attempt timeout and retry transient
// failures.
const FETCH_TIMEOUT_MS = 8_000; // per attempt
const MAX_FETCH_ATTEMPTS = 3; // initial attempt + 2 retries
const FETCH_RETRY_BACKOFF_MS = [250, 1_000]; // delay before retries 1 and 2
// pi awaits the extension factory before it builds the TUI, and extensions load
// sequentially, so the startup pre-fetch uses a tighter budget: a stalled
// endpoint would otherwise hang startup with no UI to report it.
const PREFETCH_TIMEOUT_MS = 5_000;
const PREFETCH_MAX_ATTEMPTS = 2;

interface TensorXModelInfo {
	max_tokens?: number | null;
	max_input_tokens?: number | null;
	max_output_tokens?: number | null;
	input_cost_per_token?: number | string | null;
	output_cost_per_token?: number | string | null;
	cache_read_input_token_cost?: number | string | null;
	cache_creation_input_token_cost?: number | string | null;
	supports_function_calling?: boolean | null;
	supports_vision?: boolean | null;
	supports_reasoning?: boolean | null;
}

interface TensorXModel {
	model_name: string;
	model_info?: TensorXModelInfo;
}

// Derived from ProviderConfig to avoid a direct @earendil-works/pi-ai dependency.
type ThinkingLevelMap = NonNullable<NonNullable<ProviderConfig["models"]>[number]["thinkingLevelMap"]>;

type RegisteredModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: { supportsDeveloperRole: boolean; maxTokensField: "max_tokens" };
};

// TensorX fronts OpenAI-compatible backends that don't accept the `developer`
// role or `max_completion_tokens`.
const MODEL_COMPAT = {
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as const satisfies RegisteredModel["compat"];

// Which `reasoning_effort` values a model accepts, keyed by pi thinking level.
// `null` marks a level as unsupported (pi hides it and clamps a saved setting
// to the nearest available one); a string is sent instead of the level's own
// name; a missing key means "send the level as-is", pi's default.
//
// Nothing in the catalog carries this — see the note in AGENTS.md — so the
// entries below come from probing `/v1/chat/completions` with each level. Only
// models that reject a level pi would otherwise offer are listed; everything
// else keeps pi's defaults.
const MODEL_THINKING_LEVELS: { prefix: string; map: ThinkingLevelMap }[] = [
	{
		// qwen3.8 takes low/medium/xhigh only, and defaults to xhigh. `off`
		// mapping to "none" is probed-accepted, not verified to disable
		// thinking — but without it `off` sent nothing and the model went on
		// reasoning at its default.
		prefix: "qwen/qwen3.8-2.4t-a95b",
		map: { off: null, minimal: null, high: null, xhigh: "xhigh" },
	},
	{
		prefix: "qwen/qwen3.8",
		map: { off: "none", minimal: null, high: null, xhigh: "xhigh" },
	},
	{
		// Rejects "minimal"; low/medium/high/none all work.
		prefix: "z-ai/glm-5.1",
		map: { minimal: null },
	},
];

// Match on the lowercased ID: `toRegisteredModel()` runs before mapCatalog()
// folds case, and the catalog has shipped mixed-case IDs.
function thinkingLevelMapFor(modelId: string): ThinkingLevelMap | undefined {
	const id = modelId.toLowerCase();
	return MODEL_THINKING_LEVELS.find((entry) => id.startsWith(entry.prefix))?.map;
}

function tokenCostToMillions(raw: number | string | null | undefined, field: string, modelId: string): number {
	if (raw === null || raw === undefined) return 0;
	const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
	if (Number.isFinite(value)) return value * COST_PER_MILLION;
	// pi's model shape requires a number, so an unparsable rate has to become 0.
	// Say so rather than silently reporting the model as free.
	console.warn(`[${PROVIDER_NAME}] ${modelId}: unparsable ${field} (${JSON.stringify(raw)}), treating as 0`);
	return 0;
}

// A 429 body is `{"error": {"message", "type", "code", "reason"}}`, but the
// wrapping `error` key has not always been there, so accept a flat body too.
function parseRateLimitBody(body: string): { message?: string; reason?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const record = parsed as Record<string, unknown>;
	const error = (typeof record.error === "object" && record.error !== null ? record.error : record) as Record<
		string,
		unknown
	>;
	return {
		message: typeof error.message === "string" ? error.message : undefined,
		reason: typeof error.reason === "string" ? error.reason : undefined,
	};
}

function formatHeadroom(headers: Headers, kind: "requests" | "tokens"): string | undefined {
	const remaining = headers.get(`x-ratelimit-remaining-${kind}`);
	const limit = headers.get(`x-ratelimit-limit-${kind}`);
	if (remaining === null && limit === null) return undefined;
	if (remaining !== null && limit !== null) return `${remaining}/${limit} ${kind} left`;
	return remaining === null ? `limit ${limit} ${kind}` : `${remaining} ${kind} left`;
}

// Fold the rate-limit headers and the `reason` field into one sentence.
//
// Keep the words "rate limit" in it: pi decides whether to retry a failed turn
// by pattern-matching the error text (`isRetryableAssistantError()` in pi-ai's
// `utils/retry.ts`). By the same token, do not describe the limit in terms of
// billing or quota — those words mark an error as *non*-retryable there, and a
// throttle is exactly the case pi should retry.
function describeRateLimit(headers: Headers, body: string): string {
	const { message, reason } = parseRateLimitBody(body);
	const limit = reason ? (RATE_LIMIT_REASONS[reason] ?? reason) : undefined;

	const parts = [limit ? `TensorX rate limit exceeded (${limit})` : "TensorX rate limit exceeded"];
	const retryAfter = headers.get("retry-after");
	if (retryAfter) parts.push(`retry after ${retryAfter}s`);
	const reset = headers.get("x-ratelimit-reset");
	if (reset) parts.push(`resets ${reset}`);
	const requests = formatHeadroom(headers, "requests");
	if (requests) parts.push(requests);
	const tokens = formatHeadroom(headers, "tokens");
	if (tokens) parts.push(tokens);

	const detail = `${parts.join("; ")}. Limits scale with spend: ${RATE_LIMIT_DOCS_URL}`;
	return message ? `${detail} — TensorX said: ${message}` : detail;
}

function toRegisteredModel(model: TensorXModel): RegisteredModel | undefined {
	const info = model.model_info;
	if (!info?.supports_function_calling) return undefined;

	const contextWindow = info.max_input_tokens ?? info.max_tokens ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = info.max_output_tokens ?? Math.min(contextWindow, DEFAULT_MAX_OUTPUT_TOKENS);
	const input: ("text" | "image")[] = info.supports_vision ? ["text", "image"] : ["text"];

	return {
		id: model.model_name,
		name: model.model_name,
		reasoning: info.supports_reasoning === true,
		thinkingLevelMap: thinkingLevelMapFor(model.model_name),
		input,
		cost: {
			input: tokenCostToMillions(info.input_cost_per_token, "input_cost_per_token", model.model_name),
			output: tokenCostToMillions(info.output_cost_per_token, "output_cost_per_token", model.model_name),
			cacheRead: tokenCostToMillions(
				info.cache_read_input_token_cost,
				"cache_read_input_token_cost",
				model.model_name,
			),
			cacheWrite: tokenCostToMillions(
				info.cache_creation_input_token_cost,
				"cache_creation_input_token_cost",
				model.model_name,
			),
		},
		contextWindow,
		maxTokens,
		compat: MODEL_COMPAT,
	};
}

// Keep tool-capable models, drop duplicate IDs (the catalog has a few), map to
// pi's model shape.
//
// Some duplicates differ only in case — the catalog has shipped both
// `moonshotai/Kimi-K2.6` and `moonshotai/kimi-k2.6` — so dedup case-insensitively
// and keep the all-lowercase spelling, which is what every other ID uses. Model
// IDs go out on the wire, so this picks a spelling rather than folding case.
function mapCatalog(data: TensorXModel[]): RegisteredModel[] {
	const byKey = new Map<string, RegisteredModel>();
	for (const model of data) {
		const registeredModel = toRegisteredModel(model);
		if (!registeredModel) continue;
		const key = registeredModel.id.toLowerCase();
		const existing = byKey.get(key);
		// Keep the first entry unless a later one is the lowercase spelling.
		if (existing && (existing.id === key || registeredModel.id !== key)) continue;
		byKey.set(key, registeredModel);
	}
	return [...byKey.values()];
}

class CatalogFetchTimeoutError extends Error {
	constructor() {
		super("catalog fetch timed out");
		this.name = "CatalogFetchTimeoutError";
	}
}

/**
 * Fetch the catalog with a per-attempt timeout, aborting when the caller's
 * signal fires. Throws `CatalogFetchTimeoutError` on timeout.
 */
async function fetchCatalog(apiKey: string, signal: AbortSignal, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new CatalogFetchTimeoutError()), timeoutMs);
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(`${BASE_URL}/model/info`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type FetchAttemptResult =
	| { kind: "ok"; models: RegisteredModel[] }
	| { kind: "fatal"; reason: string }
	| { kind: "retryable"; reason: string }
	| { kind: "aborted" };

async function attemptFetch(
	apiKey: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<FetchAttemptResult> {
	if (signal.aborted) return { kind: "aborted" };

	let response: Response;
	try {
		response = await fetchCatalog(apiKey, signal, timeoutMs);
	} catch (error) {
		if (signal.aborted) return { kind: "aborted" };
		if (error instanceof CatalogFetchTimeoutError) {
			return { kind: "retryable", reason: "catalog fetch timed out" };
		}
		return {
			kind: "retryable",
			reason: `network error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!response.ok) {
		// A throttled refresh is worth explaining too: it is the same 429, and
		// "API returned 429" alone does not say when the catalog can be fetched.
		const detail =
			response.status === 429 ? ` — ${describeRateLimit(response.headers, await response.text())}` : "";
		const reason = `API returned ${response.status} ${response.statusText}${detail}`;
		// 429 and 5xx are transient; other 4xx (bad key, unknown endpoint) will
		// not succeed on retry.
		if (response.status === 429 || response.status >= 500) return { kind: "retryable", reason };
		return { kind: "fatal", reason };
	}

	try {
		const json = (await response.json()) as { data?: unknown };
		if (!Array.isArray(json.data)) {
			return { kind: "retryable", reason: "Unexpected API response shape" };
		}

		return { kind: "ok", models: mapCatalog(json.data as TensorXModel[]) };
	} catch (error) {
		return {
			kind: "retryable",
			reason: `Invalid API response: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Fetch the model catalog, retrying transient failures (timeouts, network
 * errors, HTTP 429/5xx, invalid responses) with backoff. Fails fast on
 * permanent errors such as a bad API key. Returns undefined when all attempts
 * fail or the caller's signal aborts.
 */
async function fetchModels(
	apiKey: string,
	signal: AbortSignal,
	options: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<RegisteredModel[] | undefined> {
	const { timeoutMs = FETCH_TIMEOUT_MS, maxAttempts = MAX_FETCH_ATTEMPTS } = options;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			if (signal.aborted) return undefined;
			await sleep(FETCH_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
		}

		const result = await attemptFetch(apiKey, signal, timeoutMs);
		switch (result.kind) {
			case "ok":
				return result.models;
			case "fatal":
				console.warn(`[${PROVIDER_NAME}] ${result.reason}`);
				return undefined;
			case "aborted":
				return undefined;
			case "retryable":
				console.warn(`[${PROVIDER_NAME}] ${result.reason} (attempt ${attempt + 1} of ${maxAttempts})`);
		}
	}

	console.warn(`[${PROVIDER_NAME}] Catalog fetch failed after ${maxAttempts} attempts`);
	return undefined;
}

/**
 * Read our entry from pi's persisted provider store (the file we write via
 * `context.publish({ persist })`). Seeding `models:` at registration with the
 * last-known-good catalog keeps the models visible in the model picker while
 * pi's refresh is still running: the picker reads pi's snapshot, which is only
 * rebuilt when the refresh settles, so an empty registration list means no
 * models for the whole refresh duration.
 *
 * Best-effort: returns undefined on any error (missing file, unreadable,
 * malformed JSON, unknown store layout), in which case the extension behaves
 * as before. The store format is pi-internal (JSON object keyed by provider
 * ID), so the read is guarded and only the models array for this provider is
 * used. `getAgentDir` is accessed via the namespace with an optional call so
 * old pi versions without the export do not break the extension.
 */
function readCachedModels(): RegisteredModel[] | undefined {
	try {
		const getAgentDir = (piCodingAgent as { getAgentDir?: () => string }).getAgentDir;
		if (!getAgentDir) return undefined;

		const storePath = join(getAgentDir(), "models-store.json");
		const data = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
		const entry = data[PROVIDER_NAME];
		if (!entry || typeof entry !== "object") return undefined;

		const models = (entry as { models?: unknown }).models;
		if (!Array.isArray(models)) return undefined;

		// The store holds what toStoredModel() wrote, so run the entries back
		// through fromStoredModel() — same as the refresh hook's `context.stored`
		// restore — to drop the provider-level fields pi reapplies itself.
		const validModels = models
			.filter((m): m is StoredModel => typeof (m as { id?: unknown } | null)?.id === "string")
			.map(fromStoredModel);
		return validModels.length > 0 ? validModels : undefined;
	} catch {
		return undefined;
	}
}

// Derived from ProviderConfig to avoid a direct @earendil-works/pi-ai dependency.
type RefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type StoredCatalog = NonNullable<Parameters<RefreshContext["publish"]>[0]["persist"]>;
type StoredModel = StoredCatalog["models"][number];

// The models pi currently knows about. Seeded at load, replaced by a successful
// refresh, and returned by refreshModels() when a refresh can't improve on it —
// returning a shorter list would drop models pi already offers.
let currentModels: RegisteredModel[] = [];

function credentialApiKey(credential: RefreshContext["credential"]): string | undefined {
	return credential?.type === "api_key" ? credential.key : undefined;
}

// The persisted catalog holds fully-resolved models; the provider-level fields
// pi would otherwise apply from the registration are baked in here.
function toStoredModel(model: RegisteredModel): StoredModel {
	return { ...model, provider: PROVIDER_NAME, api: PROVIDER_API, baseUrl: BASE_URL };
}

// Drops the provider-level fields toStoredModel() baked in; pi reapplies them
// from the registration when the returned list is composed. The thinking-level
// map is re-derived from the ID rather than read back, so a stored catalog
// written by an older version of the table picks up the current one.
function fromStoredModel(model: StoredModel): RegisteredModel {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		thinkingLevelMap: thinkingLevelMapFor(model.id),
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: MODEL_COMPAT,
	};
}

// Dynamic catalog hook. pi calls this without network access on startup and
// after credential changes, and with it when the user opens /model or runs
// `pi update --models`. Persisting means the next session starts from the stored
// catalog instead of an empty list.
//
// context.credential carries whatever pi resolved for this provider: a key saved
// through /login, or TENSORX_API_KEY via the `$TENSORX_API_KEY` registration
// below — pi's api-key auth falls back to the env var itself, so there is no
// need to read process.env here.
async function refreshModels(context: RefreshContext): Promise<RegisteredModel[]> {
	const stored = context.stored?.models;
	// Publish the restore rather than assigning directly: publication is
	// generation-checked, so a superseded refresh can't overwrite a newer list.
	if (stored?.length) {
		const restored = stored.map(fromStoredModel);
		const published = await context.publish({
			update: () => {
				currentModels = restored;
			},
		});
		if (!published) return currentModels;
	}

	const apiKey = credentialApiKey(context.credential);
	if (!context.allowNetwork || !apiKey) return currentModels;

	const fetched = await fetchModels(apiKey, context.signal);
	if (!fetched?.length) return currentModels;

	// publish() is generation-checked: `update` runs only if this refresh is
	// still the current one, so the in-memory list can't outrun what was stored.
	// A store failure must not fail the refresh, so it is logged and ignored —
	// the fetched list is still what pi gets.
	try {
		await context.publish({
			persist: { models: fetched.map(toStoredModel), checkedAt: Date.now() },
			update: () => {
				currentModels = fetched;
			},
		});
	} catch (error) {
		console.warn(`[${PROVIDER_NAME}] Failed to persist model catalog:`, error);
	}
	return fetched;
}

type FetchFunction = typeof globalThis.fetch;

// Rewrite a 429 body into one readable sentence.
//
// Inference errors reach the user as `429: <body>`: pi's openai-completions
// adapter composes that from the OpenAI SDK's APIError, which is raised before
// pi's `after_provider_response` hook runs, so the `retry-after` and
// `x-ratelimit-*` headers never surface anywhere. A fetch wrapper is the one
// place where the headers and the body are both still in hand.
//
// The replacement body is plain text on purpose: the SDK folds a non-JSON body
// into the error message verbatim, while a JSON one is re-serialized and
// printed as a blob — which is what made the original message unreadable.
function withRateLimitDetail(inner: FetchFunction = fetch): FetchFunction {
	return async (input, init) => {
		const response = await inner(input, init);
		if (response.status !== 429) return response;

		const body = await response.text();
		// Keep the original headers so pi's provider-level retry can still read
		// `retry-after`, but drop the ones that described the body we replaced.
		const headers = new Headers(response.headers);
		headers.set("content-type", "text/plain; charset=utf-8");
		headers.delete("content-length");
		headers.delete("content-encoding");

		return new Response(describeRateLimit(response.headers, body), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

// pi has no hook for the provider's HTTP responses, so the extension takes over
// the stream call to inject the fetch above and hands it straight back to pi's
// own openai-completions implementation.
//
// The cast keeps the type universes apart. At runtime there is one pi-ai: pi's
// loader aliases both `@earendil-works/pi-ai` and pi-coding-agent's own import
// to its bundled copy. At build time npm may hoist a second copy for this
// package's devDependency, and the two declarations of
// `AssistantMessageEventStream` are then nominally distinct (it has a private
// field). `ProviderConfig["streamSimple"]` — the signature pi actually calls —
// stays the checked one.
const completionsApi = openAICompletionsApi() as unknown as { streamSimple: StreamSimple };

const streamSimple: StreamSimple = (model, context, options) =>
	completionsApi.streamSimple(model, context, { ...options, fetch: withRateLimitDetail(options?.fetch) });

export default async function (pi: ExtensionAPI) {
	// Pi does not invoke refreshModels in non-interactive modes (e.g.
	// `pi --list-models`), so pre-fetch with the environment key when it is set —
	// at load there is no session context to resolve a saved credential from, so
	// the environment is the only key source available here. The pre-fetch uses a
	// tighter timeout/retry budget because pi awaits this factory before it builds
	// the UI.
	const initialKey = process.env[API_KEY_ENV_VAR];
	const initialModels = initialKey
		? await fetchModels(initialKey, new AbortController().signal, {
				timeoutMs: PREFETCH_TIMEOUT_MS,
				maxAttempts: PREFETCH_MAX_ATTEMPTS,
			})
		: undefined;
	// Seed from the persisted last-known-good catalog when the pre-fetch produced
	// nothing (no env key, or the API was unreachable). Registering with models
	// keeps them selectable while pi's refresh is still in flight: the picker
	// reads pi's snapshot, which only reflects the registered models until the
	// refresh settles. Failing that, register with no models and let
	// refreshModels() fill them in — pi lists the provider under /login → API Keys
	// on its auth config alone, and refreshes the catalog over the network right
	// after a key is saved.
	currentModels = initialModels ?? readCachedModels() ?? [];

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_ENV_REF,
		api: PROVIDER_API,
		models: currentModels,
		refreshModels,
		streamSimple,
	});

	pi.registerCommand("tensorx-models", {
		description: "List available TensorX models",
		handler: async (_args, ctx) => {
			// Read currentModels, not the load-time list: a refresh may have
			// replaced it since.
			if (currentModels.length === 0) {
				ctx.ui.notify("No TensorX models available", "warning");
				return;
			}

			const items = [...currentModels]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => {
					const tags = [];
					if (model.reasoning) tags.push("reasoning");
					if (model.input.includes("image")) tags.push("vision");
					return tags.length > 0 ? `${model.id} (${tags.join(", ")})` : model.id;
				});

			await ctx.ui.select(`${PROVIDER_DISPLAY_NAME} — ${currentModels.length} models`, items);
		},
	});
}
