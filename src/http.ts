export interface BetterKeyClientOptions {
    apiKey: string;
    baseUrl: string;
    userAgent?: string;
    timeoutMs?: number;
}

export interface BetterKeyErrorPayload {
    error?: string;
    type?: string;
    message?: string;
    retry?: { recommended?: boolean; after?: string; reason?: string };
    [k: string]: unknown;
}

export class BetterKeyApiError extends Error {
    readonly status: number;
    readonly type: string;
    readonly retryAfterSeconds?: number;
    readonly payload: BetterKeyErrorPayload;

    constructor(status: number, type: string, message: string, payload: BetterKeyErrorPayload, retryAfterSeconds?: number) {
        super(message);
        this.name = "BetterKeyApiError";
        this.status = status;
        this.type = type;
        this.payload = payload;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class BetterKeyClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly userAgent: string;
    private readonly timeoutMs: number;

    constructor(opts: BetterKeyClientOptions) {
        if (!opts.apiKey || opts.apiKey.trim() === "") {
            throw new Error("BETTERKEY_API_KEY is required");
        }
        if (!opts.baseUrl || opts.baseUrl.trim() === "") {
            throw new Error("BETTERKEY_API_BASE is required");
        }
        this.apiKey = opts.apiKey.trim();
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.userAgent = opts.userAgent ?? "betterkey-mcp/0.1.0";
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    async get<T>(path: string, query?: Record<string, string | boolean | undefined>): Promise<T> {
        const url = this.buildUrl(path, query);
        return this.request<T>("GET", url);
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        const url = this.buildUrl(path);
        return this.request<T>("POST", url, body);
    }

    // postWithHeaders exposes a few response headers alongside the parsed body so a tool
    // that cares about X-Command-Confirmation ("confirmed" vs "unconfirmed") or
    // X-Operation-Id (for idempotency debugging) can surface them without a second call.
    async postWithHeaders<T>(path: string, body?: unknown): Promise<{ body: T; headers: Record<string, string> }> {
        const url = this.buildUrl(path);
        return this.requestWithHeaders<T>("POST", url, body);
    }

    private buildUrl(path: string, query?: Record<string, string | boolean | undefined>): string {
        if (!path.startsWith("/")) {
            throw new Error(`internal: path must start with /: ${path}`);
        }
        const url = new URL(this.baseUrl + path);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined) continue;
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
        const result = await this.requestWithHeaders<T>(method, url, body);
        return result.body;
    }

    private async requestWithHeaders<T>(
        method: string,
        url: string,
        body?: unknown,
    ): Promise<{ body: T; headers: Record<string, string> }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": this.userAgent,
        };
        let serializedBody: string | undefined;
        if (body !== undefined) {
            serializedBody = JSON.stringify(body);
            headers["Content-Type"] = "application/json";
        }
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers,
                body: serializedBody,
                signal: controller.signal,
                // Fail hard on any 3xx. WHATWG fetch would otherwise follow redirects
                // and strip the Authorization header on cross-origin hops, surfacing
                // as a confusing 401 somewhere downstream. The backend never redirects
                // today, so flagging a redirect explicitly is the right failure mode.
                redirect: "error",
            });
        } catch (err) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === "AbortError") {
                throw new BetterKeyApiError(0, "timeout", `Request timed out after ${this.timeoutMs}ms`, {});
            }
            const msg = err instanceof Error ? err.message : String(err);
            throw new BetterKeyApiError(0, "network", redactApiKey(msg, this.apiKey), {});
        } finally {
            clearTimeout(timer);
        }

        if (res.ok) {
            const parsed = (await res.json()) as T;
            return { body: parsed, headers: pickExposedHeaders(res.headers) };
        }

        const retryAfterRaw = res.headers.get("Retry-After");
        const retryAfterSeconds = parseRetryAfter(retryAfterRaw);
        const payload = await safeParseErrorBody(res);
        const type = typeof payload.type === "string" && payload.type.length > 0
            ? payload.type
            : mapStatusToType(res.status);
        const message = typeof payload.message === "string" && payload.message.length > 0
            ? payload.message
            : typeof payload.error === "string" && payload.error.length > 0
                ? payload.error
                : `HTTP ${res.status}`;
        throw new BetterKeyApiError(
            res.status,
            type,
            redactApiKey(message, this.apiKey),
            payload,
            retryAfterSeconds,
        );
    }
}

async function safeParseErrorBody(res: Response): Promise<BetterKeyErrorPayload> {
    try {
        const text = await res.text();
        if (!text) return {};
        try {
            return JSON.parse(text) as BetterKeyErrorPayload;
        } catch {
            return { message: text };
        }
    } catch {
        return {};
    }
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
    const d = Date.parse(value);
    if (Number.isFinite(d)) {
        const diff = Math.max(0, Math.round((d - Date.now()) / 1000));
        return diff;
    }
    return undefined;
}

function mapStatusToType(status: number): string {
    if (status === 401) return "unauthorized";
    if (status === 402) return "subscription_required";
    if (status === 403) return "forbidden";
    if (status === 404) return "not_found";
    if (status === 409) return "conflict";
    if (status === 429) return "rate_limit";
    if (status >= 500 && status < 600) return "upstream";
    return "unknown";
}

// httpErrorHint returns a short, agent-actionable sentence for well-known backend error
// types. Returning undefined means "no extra guidance" — the generic message is already
// clear enough. Centralized here so every tool error-path uses the same wording.
export function httpErrorHint(type: string, requiredScope?: string): string | undefined {
    switch (type) {
        case "unauthorized":
            return "The BetterKey API key was rejected. Mint a new key in the BetterKey app and update the MCP server's BETTERKEY_API_KEY environment variable.";
        case "insufficient_scope":
            return requiredScope
                ? `This tool requires the ${requiredScope} scope on your BetterKey API key. Revoke the current key and mint a new one with that scope enabled.`
                : "This tool requires a scope your current API key does not grant. Revoke the key and mint a new one with the needed scope.";
        case "subscription_required":
            return "An active BetterKey subscription is required for this action.";
        case "conflict":
            return "Another command is already in flight for this vehicle. Wait a few seconds and try again.";
        case "rate_limit":
            return "The backend is rate-limiting this key. Honor the retryAfterSeconds hint before trying again.";
        default:
            return undefined;
    }
}

export function redactApiKey(input: string, apiKey: string): string {
    if (!apiKey) return input;
    const prefix = apiKey.slice(0, 4);
    return input.split(apiKey).join(`${prefix}…[redacted]`);
}

// EXPOSED_HEADERS is the allowlist of response headers that tools are permitted to echo
// back to the agent. Deliberately narrow: everything else (Set-Cookie, Server, Fly-Request-Id,
// anything we don't recognize) stays server-side so a header rename cannot accidentally
// become an agent-visible contract.
const EXPOSED_HEADERS = new Set(["x-command-confirmation", "x-operation-id", "x-smartcar-upstream-status"]);

function pickExposedHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
        if (EXPOSED_HEADERS.has(key.toLowerCase())) {
            out[key.toLowerCase()] = value;
        }
    });
    return out;
}
