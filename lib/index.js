/**
 * Brave Search provider for the DeepSeek Harness web seam (`ctx.web`). Registers as the
 * `brave` search provider and serves the built-in model-facing `web_search` tool
 * (`dsh-tool-web`) from the Brave Web Search API. The API key is resolved per search
 * through `ctx.credentials` (or the launch environment), so a key stored or rotated at
 * runtime reaches the next search without a restart and is never retained.
 * @module dsh-brave
 */
import { setTimeout as sleep } from "node:timers/promises";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable id this provider registers under; select it with `web.searchProvider: brave`. */
export const BRAVE_PROVIDER_ID = "brave";
/** Brave API base; `/web/search` is appended. */
export const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";
/** Brave caps `count` at 20 results per request. */
const BRAVE_MAX_COUNT = 20;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-brave/0.1.0";

/**
 * Serializes request starts so consecutive searches stay at least `intervalMs` apart
 * (the free Brave plan allows one request per second). A 429 pushes the next slot
 * past the advertised reset.
 */
class Throttle {
	next = 0;
	/** Wait for this caller's slot; cancellation still consumes the reserved slot. */
	async acquire(intervalMs, signal) {
		const now = Date.now();
		const at = Math.max(now, this.next);
		this.next = at + intervalMs;
		if (at > now) await sleep(at - now, void 0, { signal });
	}
	/** Defer every later request until `ms` from now. */
	backoff(ms) {
		this.next = Math.max(this.next, Date.now() + ms);
	}
}

/**
 * The Brave-backed search provider. Options are re-read at each operation's entry, so a
 * config change applies to the next search without re-registering the provider.
 */
export class BraveSearchProvider {
	id = BRAVE_PROVIDER_ID;
	throttle = new Throttle();
	/** @param resolveOptions - the options for the NEXT operation. */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	/**
	 * Cheap local check: a credential source exists. Whether the store actually holds the key
	 * is asynchronous, so a missing key fails the search with `WEB_PROVIDER_CREDENTIAL_MISSING`
	 * (a clearer message than the seam's generic "configured provider unavailable").
	 */
	available() {
		const options = this.resolveOptions();
		return (options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0;
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const endpoint = searchEndpoint(options.baseURL);
		const apiKey = await this.apiKey(options, signal);
		const url = new URL(endpoint);
		url.search = searchParams(request, options).toString();

		for (let attempt = 0; ; attempt++) {
			await this.acquireSlot(options.minIntervalMs, signal);
			const response = await this.dispatch(url, apiKey, options.timeoutMs, signal);
			if (response.ok) return mapBraveResponse(await readJson(response, signal));

			const detail = await errorDetail(response, signal);
			if (response.status === 429) {
				const waitMs = rateLimitWaitMs(response.headers);
				if (waitMs !== void 0) this.throttle.backoff(waitMs);
				if (attempt < options.maxRetries && waitMs !== void 0 && waitMs <= options.maxRetryWaitMs) continue;
				throw new WebError(`${detail}\n\nBrave rate limit or plan quota exceeded${waitMs === void 0 ? "" : `; the limit resets in ${Math.ceil(waitMs / 1e3)}s`}. Retry later or upgrade the Brave Search API plan.`, "WEB_PROVIDER_RATE_LIMITED");
			}
			if (response.status === 401 || response.status === 403) throw new WebError(`${detail}\n\nBrave rejected the API key from "${options.apiKeyEnv}". Guide the user to check the key and its subscription at https://api-dashboard.search.brave.com; only the user should change it.`, "WEB_PROVIDER_ERROR");
			throw new WebError(detail, "WEB_PROVIDER_ERROR");
		}
	}
	async acquireSlot(intervalMs, signal) {
		try {
			await this.throttle.acquire(intervalMs, signal);
		} catch (error) {
			throw searchAborted(signal, error);
		}
	}
	/** One HTTP attempt under the caller's signal plus a per-attempt timeout. */
	async dispatch(url, apiKey, timeoutMs, signal) {
		const timeout = AbortSignal.timeout(timeoutMs);
		try {
			return await fetch(url, {
				method: "GET",
				redirect: "error",
				headers: {
					"accept": "application/json",
					"x-subscription-token": apiKey,
					"user-agent": USER_AGENT
				},
				signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
			});
		} catch (error) {
			if (signal?.aborted === true) throw searchAborted(signal, error);
			if (timeout.aborted) throw new WebError(`Brave search timed out after ${timeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
			throw new WebError(`Brave search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	/** Resolve one operation's API key without retaining it on the provider. */
	async apiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await options.resolveApiKey?.();
		} catch (error) {
			throw new WebError(`Brave search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		throwIfAborted(signal);
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError(`Brave search has no API key for "${options.apiKeyEnv}"; store it through the credentials service (${"$"}DSH_HOME/.credentials.yaml), export it in the environment that launches dsh, or set a literal "apiKey" in the web-search-brave config. Keys are issued at https://api-dashboard.search.brave.com`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
}

/**
 * Build the `/web/search` endpoint from a configured base. Only https is accepted so the
 * subscription token never travels in clear text.
 * @throws {@link WebError} when the base is not an https URL.
 */
function searchEndpoint(baseURL) {
	const base = URL.canParse(baseURL) ? new URL(baseURL) : void 0;
	if (base?.protocol !== "https:") throw new WebError(`Brave search baseURL ${JSON.stringify(baseURL)} is not an https URL; guide the user to fix web-search-brave.baseURL (default ${BRAVE_DEFAULT_BASE_URL})`, "WEB_PROVIDER_ERROR");
	return `${base.href.replace(/\/+$/u, "")}/web/search`;
}

/** Map a seam request plus config onto Brave query parameters. */
function searchParams(request, options) {
	const params = new URLSearchParams({
		q: request.query,
		count: String(clamp(request.maxResults ?? options.count, 1, Math.min(options.count, BRAVE_MAX_COUNT))),
		safesearch: options.safesearch,
		text_decorations: "false",
		result_filter: "web,query"
	});
	if (options.country !== void 0 && options.country.length > 0) params.set("country", options.country);
	if (options.searchLang !== void 0 && options.searchLang.length > 0) params.set("search_lang", options.searchLang);
	if (options.freshness !== void 0 && options.freshness.length > 0) params.set("freshness", options.freshness);
	if (options.extraSnippets) params.set("extra_snippets", "true");
	return params;
}

/**
 * Map a Brave Web Search response to a normalized search result: `web.results[]` become
 * deduplicated sources with cleaned snippets; a spell-corrected query is surfaced as
 * `content` so the model knows what was actually searched. The seam owns `maxResults`
 * truncation, so `truncated` is always `false` here.
 * @throws {@link WebError} when the body carries no `web.results` array and no query echo.
 */
export function mapBraveResponse(body) {
	const results = body?.web?.results;
	if (!Array.isArray(results)) {
		// Brave omits the `web` section when nothing matched; anything else is malformed.
		if (body?.query !== void 0) return { sources: [], truncated: false };
		throw new WebError("Brave returned an unprocessable response body (no web.results)", "WEB_PROVIDER_ERROR");
	}
	const seen = new Set();
	const sources = [];
	for (const item of results) {
		const url = typeof item?.url === "string" ? item.url : "";
		if (!isHttpUrl(url) || seen.has(url)) continue;
		seen.add(url);
		const title = cleanText(item.title);
		const snippet = [item.description, ...Array.isArray(item.extra_snippets) ? item.extra_snippets : []].map(cleanText).filter((text) => text.length > 0).join(" … ");
		const publishedAt = isoDate(item.page_age);
		sources.push({
			url,
			...title.length > 0 ? { title } : {},
			...snippet.length > 0 ? { snippet } : {},
			...publishedAt !== void 0 ? { publishedAt } : {}
		});
	}
	const altered = cleanText(body.query?.altered);
	return {
		...altered.length > 0 ? { content: `Brave showed results for the corrected query "${altered}".` } : {},
		sources,
		truncated: false
	};
}

/** Parse a successful body; abort while reading stays `WEB_ABORTED`. */
async function readJson(response, signal) {
	try {
		return await response.json();
	} catch (error) {
		if (signal?.aborted === true) throw searchAborted(signal, error);
		throw new WebError(`Brave returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
	}
}

/**
 * Describe a failed response. Brave errors look like
 * `{ "type": "ErrorResponse", "error": { "code", "detail", "status" } }`.
 */
async function errorDetail(response, signal) {
	let message = `Brave Search API error (HTTP ${response.status})`;
	try {
		const parsed = await response.json();
		const error = parsed?.error;
		const code = typeof error?.code === "string" ? error.code : void 0;
		const detail = typeof error === "string" ? error : error?.detail ?? error?.message ?? parsed?.message;
		if (code !== void 0) message += ` ${code}`;
		if (typeof detail === "string" && detail.length > 0) message += `: ${detail}`;
	} catch (error) {
		if (signal?.aborted === true) throw searchAborted(signal, error);
	}
	return message;
}

/**
 * Milliseconds until the exhausted Brave rate-limit window resets, from the comma-separated
 * per-window `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers (falling back to
 * `Retry-After`). `undefined` when the headers say nothing usable.
 */
function rateLimitWaitMs(headers) {
	const resets = headerList(headers.get("x-ratelimit-reset"));
	const remaining = headerList(headers.get("x-ratelimit-remaining"));
	const exhausted = resets.filter((_, index) => remaining[index] === 0);
	const seconds = exhausted.length > 0 ? Math.max(...exhausted) : resets.length > 0 ? resets[0] : headerList(headers.get("retry-after"))[0];
	return seconds === void 0 ? void 0 : Math.max(seconds, 1) * 1e3;
}

function headerList(value) {
	return (value ?? "").split(",").map((part) => Number(part.trim())).filter((part) => Number.isFinite(part) && part >= 0);
}

const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	nbsp: " "
};

/** Strip markup and decode entities from Brave titles and descriptions. */
function cleanText(value) {
	if (typeof value !== "string") return "";
	return value.replace(/<[^>]*>/gu, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
		if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
		const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
		return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : match;
	}).replace(/\s+/gu, " ").trim();
}

/** Keep `page_age` only when it is an ISO-8601 timestamp (Brave's `age` is prose like "2 days ago"). */
function isoDate(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) && !Number.isNaN(Date.parse(value)) ? value : void 0;
}

function isHttpUrl(value) {
	if (!URL.canParse(value)) return false;
	const { protocol } = new URL(value);
	return protocol === "https:" || protocol === "http:";
}

function clamp(value, min, max) {
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function throwIfAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Brave search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-brave";
/** The web seam this provider registers into. */
export const inject = ["web"];
export const Config = z.object({
	apiKey: z.string().role("secret").description("Literal Brave API key; prefer apiKeyEnv so no secret enters configuration files.").volatile(),
	apiKeyEnv: z.string().role("credential-ref").default("BRAVE_API_KEY").description("Credential reference resolved for each search through ctx.credentials, else the launch environment.").volatile(),
	baseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).description("Brave API base (https only); /web/search is appended.").volatile(),
	count: z.number().step(1).min(1).max(BRAVE_MAX_COUNT).default(10).description("Upper bound on results requested per search; the tool's maxResults can only lower it.").volatile(),
	country: z.string().description("Two-letter country code to bias results, e.g. US, DE. Empty = Brave default.").volatile(),
	searchLang: z.string().description("Result language code, e.g. en, ru. Empty = Brave default.").volatile(),
	safesearch: z.union(["off", "moderate", "strict"]).default("moderate").description("Adult content filter.").volatile(),
	freshness: z.string().description("Recency filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. Empty = any time.").volatile(),
	extraSnippets: z.boolean().default(false).description("Request up to 5 extra excerpts per result (paid Brave plans).").volatile(),
	timeoutMs: z.number().step(1).min(1e3).default(15e3).description("Timeout of one HTTP attempt, in milliseconds.").volatile(),
	minIntervalMs: z.number().step(1).min(0).default(1100).description("Minimum spacing between request starts; the free plan allows 1 request per second.").volatile(),
	maxRetries: z.number().step(1).min(0).max(5).default(2).description("Retries after HTTP 429 when the limit resets soon.").volatile(),
	maxRetryWaitMs: z.number().step(1).min(0).default(5e3).description("Longest rate-limit reset worth waiting for before failing.").volatile()
});

/**
 * Project the current config into the options one search runs with. A mounted credentials
 * service is authoritative; without one the key comes from the launching environment.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = config.apiKeyEnv.get();
	const literalApiKey = config.apiKey.get();
	return {
		...literalApiKey !== void 0 && literalApiKey.length > 0 ? { apiKey: literalApiKey } : {},
		resolveApiKey: async () => {
			const ref = credentialRef(apiKeyEnv);
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(ref))?.value;
			return launchEnvironmentOf(ctx).get(ref)?.value;
		},
		apiKeyEnv,
		baseURL: config.baseURL.get(),
		count: config.count.get(),
		country: config.country.get(),
		searchLang: config.searchLang.get(),
		safesearch: config.safesearch.get(),
		freshness: config.freshness.get(),
		extraSnippets: config.extraSnippets.get(),
		timeoutMs: config.timeoutMs.get(),
		minIntervalMs: config.minIntervalMs.get(),
		maxRetries: config.maxRetries.get(),
		maxRetryWaitMs: config.maxRetryWaitMs.get()
	};
}

/** Register the Brave search provider with `ctx.web`; the fiber disposes the registration. */
export function apply(ctx, config) {
	ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(ctx, config)));
}
