import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BetterKeyApiError, BetterKeyClient, httpErrorHint } from "./http.ts";

type FetchArgs = {
    url: string;
    init: RequestInit;
};

type StubbedResponse = {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
};

function installFetchStub(responder: (args: FetchArgs) => StubbedResponse): FetchArgs[] {
    const calls: FetchArgs[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const captured: FetchArgs = { url, init: init ?? {} };
        calls.push(captured);
        const r = responder(captured);
        const headers = new Headers(r.headers ?? {});
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        return new Response(JSON.stringify(r.body), { status: r.status, headers });
    }) as typeof fetch;
    // Return the shared call log so the test can inspect it; restore in afterEach.
    (installFetchStub as unknown as { original?: typeof fetch }).original = original;
    return calls;
}

function restoreFetchStub() {
    const original = (installFetchStub as unknown as { original?: typeof fetch }).original;
    if (original) globalThis.fetch = original;
}

describe("BetterKeyClient.postWithHeaders", () => {
    let calls: FetchArgs[];
    beforeEach(() => {
        calls = installFetchStub(() => ({
            status: 200,
            body: { status: "success", vehicleId: "v1", command: "lock", message: "Vehicle locked successfully" },
            headers: {
                "x-command-confirmation": "confirmed",
                "x-operation-id": "vehicle:u:v1",
                "set-cookie": "nope=should-not-leak",
            },
        }));
    });
    afterEach(() => restoreFetchStub());

    it("sends a POST with the API key and no body for a bare command", async () => {
        const client = new BetterKeyClient({ apiKey: "bk_xyz", baseUrl: "http://local" });
        const res = await client.postWithHeaders<{ status: string }>("/v1/vehicles/v1/lock");
        assert.equal(res.body.status, "success");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.init.method, "POST");
        const authHeader = (calls[0]?.init.headers as Record<string, string>)["Authorization"];
        assert.equal(authHeader, "Bearer bk_xyz");
    });

    it("surfaces only allowlisted headers", async () => {
        const client = new BetterKeyClient({ apiKey: "bk_xyz", baseUrl: "http://local" });
        const res = await client.postWithHeaders<unknown>("/v1/vehicles/v1/lock");
        assert.equal(res.headers["x-command-confirmation"], "confirmed");
        assert.equal(res.headers["x-operation-id"], "vehicle:u:v1");
        assert.ok(!("set-cookie" in res.headers), "set-cookie must not be exposed to tool output");
    });
});

describe("BetterKeyClient command errors", () => {
    afterEach(() => restoreFetchStub());

    it("surfaces the backend's insufficient_scope payload shape", async () => {
        installFetchStub(() => ({
            status: 403,
            body: {
                error: "insufficient_scope",
                type: "insufficient_scope",
                message: "The API key does not grant the required scope.",
                required: "vehicle.command",
                granted: ["telemetry.read"],
            },
        }));
        const client = new BetterKeyClient({ apiKey: "bk_xyz", baseUrl: "http://local" });
        try {
            await client.postWithHeaders<unknown>("/v1/vehicles/v1/lock");
            assert.fail("expected throw");
        } catch (err) {
            assert.ok(err instanceof BetterKeyApiError);
            if (err instanceof BetterKeyApiError) {
                assert.equal(err.status, 403);
                assert.equal(err.type, "insufficient_scope");
                assert.equal(err.payload["required"], "vehicle.command");
                assert.deepEqual(err.payload["granted"], ["telemetry.read"]);
            }
        }
    });

    it("surfaces the backend's vehicle_command_in_progress 409 payload", async () => {
        installFetchStub(() => ({
            status: 409,
            body: {
                error: "vehicle_command_in_progress",
                message: "Another vehicle command is in progress; retry after Retry-After seconds",
                retry: { recommended: true, afterSeconds: 5, reason: "vehicle_command_in_progress" },
            },
            headers: { "retry-after": "5" },
        }));
        const client = new BetterKeyClient({ apiKey: "bk_xyz", baseUrl: "http://local" });
        try {
            await client.postWithHeaders<unknown>("/v1/vehicles/v1/lock");
            assert.fail("expected throw");
        } catch (err) {
            assert.ok(err instanceof BetterKeyApiError);
            if (err instanceof BetterKeyApiError) {
                assert.equal(err.status, 409);
                // The backend doesn't set `type` on this 409 — the client fills in from status.
                assert.equal(err.type, "conflict");
                assert.equal(err.retryAfterSeconds, 5);
            }
        }
    });
});

describe("httpErrorHint", () => {
    it("names the scope on insufficient_scope", () => {
        const hint = httpErrorHint("insufficient_scope", "vehicle.command");
        assert.ok(hint && hint.includes("vehicle.command"), hint);
    });

    it("falls back cleanly when required scope is missing", () => {
        const hint = httpErrorHint("insufficient_scope");
        assert.ok(hint && hint.includes("scope"), hint);
    });

    it("returns undefined for unknown error types so the generic message is used", () => {
        assert.equal(httpErrorHint("mystery_type"), undefined);
    });

    it("gives a key-rotation hint on unauthorized", () => {
        const hint = httpErrorHint("unauthorized");
        assert.ok(hint && hint.toLowerCase().includes("api key"), hint);
    });

    it("names the subscription requirement on subscription_required", () => {
        const hint = httpErrorHint("subscription_required");
        assert.ok(hint && hint.toLowerCase().includes("subscription"), hint);
    });

    it("tells the agent to back off on conflict", () => {
        const hint = httpErrorHint("conflict");
        assert.ok(hint && hint.toLowerCase().includes("in flight"), hint);
    });

    it("points to retryAfterSeconds on rate_limit", () => {
        const hint = httpErrorHint("rate_limit");
        assert.ok(hint && hint.toLowerCase().includes("retryafterseconds"), hint);
    });
});
