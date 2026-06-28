import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "tensorx";
const PROVIDER_DISPLAY_NAME = "TensorX";
const BASE_URL = "https://api.tensorx.ai/v1";
const API_KEY_ENV_VAR = "TENSORX_API_KEY";
const API_KEY_ENV_REF = `$${API_KEY_ENV_VAR}`;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
// TensorX reports costs per token; pi expects cost per million tokens.
const COST_PER_MILLION = 1_000_000;

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

interface TensorXModelsResponse {
	data: TensorXModel[];
}

type RegisteredModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: { supportsDeveloperRole: boolean; maxTokensField: "max_tokens" };
};

function tokenCostToMillions(raw: number | string | null | undefined): number {
	if (raw === null || raw === undefined) return 0;
	const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
	return Number.isFinite(value) ? value * COST_PER_MILLION : 0;
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
		input,
		cost: {
			input: tokenCostToMillions(info.input_cost_per_token),
			output: tokenCostToMillions(info.output_cost_per_token),
			cacheRead: tokenCostToMillions(info.cache_read_input_token_cost),
			cacheWrite: tokenCostToMillions(info.cache_creation_input_token_cost),
		},
		contextWindow,
		maxTokens,
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	};
}

// Keep tool-capable models, drop duplicate IDs (the catalog has a few), map to
// pi's model shape. Used for both the live catalog and the fallback snapshot.
function mapCatalog(data: TensorXModel[]): RegisteredModel[] {
	const seen = new Set<string>();
	const models: RegisteredModel[] = [];
	for (const model of data) {
		const registeredModel = toRegisteredModel(model);
		if (!registeredModel || seen.has(registeredModel.id)) continue;
		seen.add(registeredModel.id);
		models.push(registeredModel);
	}
	return models;
}

async function fetchModels(): Promise<RegisteredModel[] | undefined> {
	const apiKey = process.env[API_KEY_ENV_VAR];
	if (!apiKey) return undefined;

	try {
		const res = await fetch(`${BASE_URL}/model/info`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!res.ok) {
			console.warn(`[${PROVIDER_NAME}] API returned ${res.status}: ${res.statusText}`);
			return undefined;
		}

		const response = (await res.json()) as TensorXModelsResponse;
		if (!Array.isArray(response.data)) {
			console.warn(`[${PROVIDER_NAME}] Unexpected API response shape`);
			return undefined;
		}

		return mapCatalog(response.data);
	} catch (error) {
		console.warn(`[${PROVIDER_NAME}] Failed to fetch models:`, error);
		return undefined;
	}
}

// Snapshot of the tool-capable TensorX catalog, in the API's native shape so it
// runs through the same mapCatalog() as the live fetch. The catalog endpoint
// needs an API key that pi does not expose to extensions, so without
// TENSORX_API_KEY in the environment the live fetch can't run — this snapshot is
// what gets registered then, which is also what makes TensorX show up under
// /login → API Keys (pi only lists providers that have at least one model).
// Regenerate from `GET /v1/model/info` when the catalog changes.
const FALLBACK_CATALOG: TensorXModel[] = [
	{ model_name: "deepseek-v4-flash-backup", model_info: { max_input_tokens: 1048576, max_output_tokens: 384000, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.5e-07, output_cost_per_token: 3e-07, cache_read_input_token_cost: 3.75e-08, cache_creation_input_token_cost: 1.875e-07 } },
	{ model_name: "deepseek/deepseek-chat-v3-0324", model_info: { max_input_tokens: 163840, max_output_tokens: 8192, supports_function_calling: true, input_cost_per_token: 3e-07, output_cost_per_token: 1e-06, cache_read_input_token_cost: 7.5e-08, cache_creation_input_token_cost: 3.75e-07 } },
	{ model_name: "deepseek/deepseek-chat-v3.1", model_info: { max_input_tokens: 164000, max_output_tokens: 163840, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 2e-07, output_cost_per_token: 8e-07, cache_read_input_token_cost: 5e-08, cache_creation_input_token_cost: 2.5e-07 } },
	{ model_name: "deepseek/deepseek-r1-0528", model_info: { max_input_tokens: 164000, max_output_tokens: 8192, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 6.6e-07, output_cost_per_token: 2.6e-06, cache_read_input_token_cost: 1.65e-07, cache_creation_input_token_cost: 8.25e-07 } },
	{ model_name: "deepseek/deepseek-v3.2", model_info: { max_input_tokens: 163840, max_output_tokens: 163840, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 3e-07, output_cost_per_token: 5e-07, cache_read_input_token_cost: 7.5e-08, cache_creation_input_token_cost: 3.75e-07 } },
	{ model_name: "deepseek/deepseek-v4-flash", model_info: { max_input_tokens: 1048576, max_output_tokens: 384000, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.5e-07, output_cost_per_token: 3e-07, cache_read_input_token_cost: 3.75e-08, cache_creation_input_token_cost: 1.875e-07 } },
	{ model_name: "deepseek/deepseek-v4-pro", model_info: { max_input_tokens: 1048576, max_output_tokens: 384000, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.75e-06, output_cost_per_token: 3.5e-06, cache_read_input_token_cost: 4.375e-07, cache_creation_input_token_cost: 2.185e-06 } },
	{ model_name: "meta-llama/llama-3.3-70b-instruct", model_info: { max_input_tokens: 131000, max_output_tokens: null, supports_function_calling: true, input_cost_per_token: 1.04e-07, output_cost_per_token: 3.12e-07, cache_read_input_token_cost: 2.6e-08, cache_creation_input_token_cost: 1.3e-07 } },
	{ model_name: "meta-llama/llama-4-maverick", model_info: { max_input_tokens: 1050000, max_output_tokens: null, supports_function_calling: true, input_cost_per_token: 1.36e-07, output_cost_per_token: 6.8e-07, cache_read_input_token_cost: 3.4e-08, cache_creation_input_token_cost: 1.7e-07 } },
	{ model_name: "minimax/minimax-m2", model_info: { max_input_tokens: 196608, max_output_tokens: 196608, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 2.5e-07, output_cost_per_token: 1e-06, cache_read_input_token_cost: 6.25e-08, cache_creation_input_token_cost: 3.125e-07 } },
	{ model_name: "minimax/minimax-m2.1", model_info: { max_input_tokens: 196608, max_output_tokens: 131072, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 3e-07, output_cost_per_token: 2.4e-06, cache_read_input_token_cost: 7.5e-08, cache_creation_input_token_cost: 3.75e-07 } },
	{ model_name: "minimax/minimax-m2.5", model_info: { max_input_tokens: 196608, max_output_tokens: 65536, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 3e-07, output_cost_per_token: 1.2e-06, cache_read_input_token_cost: 7.5e-08, cache_creation_input_token_cost: 3.75e-07 } },
	{ model_name: "minimax/minimax-m2.7", model_info: { max_input_tokens: 196608, max_output_tokens: 196608, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 5e-07, output_cost_per_token: 1.5e-06, cache_read_input_token_cost: 1.25e-07, cache_creation_input_token_cost: 6.25e-07 } },
	{ model_name: "minimax/minimax-m3", model_info: { max_input_tokens: 1048576, max_output_tokens: 131072, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 4e-07, output_cost_per_token: 2e-06, cache_read_input_token_cost: 1e-07 } },
	{ model_name: "moonshotai/Kimi-K2.6", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 1e-06, output_cost_per_token: 4e-06, cache_read_input_token_cost: 2.5e-07, cache_creation_input_token_cost: 1.25e-06 } },
	{ model_name: "moonshotai/kimi-k2.5", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_vision: true, input_cost_per_token: 5e-07, output_cost_per_token: 2.8e-06, cache_read_input_token_cost: 1.25e-07, cache_creation_input_token_cost: 6.25e-07 } },
	{ model_name: "moonshotai/kimi-k2.6", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 1e-06, output_cost_per_token: 4e-06, cache_read_input_token_cost: 2.5e-07, cache_creation_input_token_cost: 1.25e-06 } },
	{ model_name: "moonshotai/kimi-k2.7-code", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 1.25e-06, output_cost_per_token: 4.5e-06, cache_read_input_token_cost: 3.125e-07, cache_creation_input_token_cost: 0 } },
	{ model_name: "nvidia/nemotron-3-super-120b-a12b", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 3e-07, output_cost_per_token: 9e-07, cache_read_input_token_cost: 7.5e-08 } },
	{ model_name: "openai/gpt-oss-120b", model_info: { max_input_tokens: 131000, max_output_tokens: 32768, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 4e-08, output_cost_per_token: 2e-07, cache_read_input_token_cost: 1e-08, cache_creation_input_token_cost: 5e-08 } },
	{ model_name: "openai/gpt-oss-20b", model_info: { max_input_tokens: 131000, max_output_tokens: 32768, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 3e-08, output_cost_per_token: 1.4e-07, cache_read_input_token_cost: 7.5e-09, cache_creation_input_token_cost: 3.75e-08 } },
	{ model_name: "qwen/qwen-2.5-72b-instruct", model_info: { max_input_tokens: 33000, max_output_tokens: null, supports_function_calling: true, input_cost_per_token: 7e-08, output_cost_per_token: 2.6e-07, cache_read_input_token_cost: 1.75e-08, cache_creation_input_token_cost: 8.75e-08 } },
	{ model_name: "qwen/qwen3-235b-a22b-2507", model_info: { max_input_tokens: 131000, max_output_tokens: 262144, supports_function_calling: true, input_cost_per_token: 7.2e-08, output_cost_per_token: 4.64e-07, cache_read_input_token_cost: 1.8e-08, cache_creation_input_token_cost: 9e-08 } },
	{ model_name: "qwen/qwen3-coder-30b-a3b-instruct", model_info: { max_input_tokens: 262000, max_output_tokens: null, supports_function_calling: true, input_cost_per_token: 6e-08, output_cost_per_token: 2.5e-07, cache_read_input_token_cost: 1.5e-08, cache_creation_input_token_cost: 7.5e-08 } },
	{ model_name: "qwen/qwen3.5-122b-a10b", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 5e-07, output_cost_per_token: 3.5e-06, cache_read_input_token_cost: 1.25e-07, cache_creation_input_token_cost: 6.25e-07 } },
	{ model_name: "qwen/qwen3.5-9b", model_info: { max_input_tokens: 262144, max_output_tokens: 262144, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.5e-07, output_cost_per_token: 2e-07, cache_read_input_token_cost: 3.75e-08 } },
	{ model_name: "z-ai/glm-4.6", model_info: { max_input_tokens: 203000, max_output_tokens: 131000, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 4e-07, output_cost_per_token: 1.75e-06, cache_read_input_token_cost: 1e-07, cache_creation_input_token_cost: 5e-07 } },
	{ model_name: "z-ai/glm-4.7", model_info: { max_input_tokens: 200000, max_output_tokens: 200000, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 6e-07, output_cost_per_token: 2.2e-06, cache_read_input_token_cost: 1.5e-07, cache_creation_input_token_cost: 7.5e-07 } },
	{ model_name: "z-ai/glm-5", model_info: { max_input_tokens: 202752, max_output_tokens: 202752, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1e-06, output_cost_per_token: 3.2e-06, cache_read_input_token_cost: 2.5e-07, cache_creation_input_token_cost: 1.25e-06 } },
	{ model_name: "z-ai/glm-5-turbo", model_info: { max_input_tokens: 202752, max_output_tokens: 131072, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.2e-06, output_cost_per_token: 4e-06, cache_read_input_token_cost: 3e-07, cache_creation_input_token_cost: 1.5e-06 } },
	{ model_name: "z-ai/glm-5.1", model_info: { max_input_tokens: 202752, max_output_tokens: 202752, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.4e-06, output_cost_per_token: 4.4e-06, cache_read_input_token_cost: 3.5e-07, cache_creation_input_token_cost: 1.75e-06 } },
	{ model_name: "z-ai/glm-5.2", model_info: { max_input_tokens: 1048576, max_output_tokens: 131072, supports_function_calling: true, supports_reasoning: true, input_cost_per_token: 1.5e-06, output_cost_per_token: 4.5e-06, cache_read_input_token_cost: 3.75e-07 } },
	{ model_name: "z-ai/glm-5v-turbo", model_info: { max_input_tokens: 202752, max_output_tokens: 131072, supports_function_calling: true, supports_vision: true, supports_reasoning: true, input_cost_per_token: 1.2e-06, output_cost_per_token: 4e-06, cache_read_input_token_cost: 3e-07, cache_creation_input_token_cost: 1.5e-06 } },
];

export default async function (pi: ExtensionAPI) {
	// Prefer the live catalog (only reachable when TENSORX_API_KEY is in the
	// environment); otherwise register the bundled snapshot so TensorX still
	// appears under /login → API Keys and is usable with a saved key.
	const models = (await fetchModels()) ?? mapCatalog(FALLBACK_CATALOG);

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_ENV_REF,
		api: "openai-completions",
		models,
	});

	pi.registerCommand("tensorx-models", {
		description: "List available TensorX models",
		handler: async (_args, ctx) => {
			if (models.length === 0) {
				ctx.ui.notify("No TensorX models available", "warning");
				return;
			}

			const items = [...models]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => {
					const tags = [];
					if (model.reasoning) tags.push("reasoning");
					if (model.input.includes("image")) tags.push("vision");
					return tags.length > 0 ? `${model.id} (${tags.join(", ")})` : model.id;
				});

			await ctx.ui.select(`${PROVIDER_DISPLAY_NAME} — ${models.length} models`, items);
		},
	});
}
