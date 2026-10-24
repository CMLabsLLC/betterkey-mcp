import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BetterKeyClient } from "../http.ts";
import { registerGetVehicleLocation } from "./get_vehicle_location.ts";

type CapturedTool = {
    name: string;
    config: {
        title: string;
        description: string;
        annotations: Record<string, unknown>;
        inputSchema: Record<string, unknown>;
    };
    handler: (args: { vehicle_id: string }) => Promise<{
        isError?: boolean;
        content: Array<{ type: "text"; text: string }>;
    }>;
};

function stubMcpServer() {
    const tools: CapturedTool[] = [];
    const server = {
        registerTool: (name: string, config: unknown, handler: unknown) => {
            tools.push({
                name,
                config: config as CapturedTool["config"],
                handler: handler as CapturedTool["handler"],
            });
        },
    } as unknown as McpServer;
    return { server, tools };
}

type FetchArgs = { url: string; init: RequestInit };
type StubbedResponse = { status: number; body: unknown; headers?: Record<string, string> };

function installFetchStub(responder: (args: FetchArgs) => StubbedResponse): FetchArgs[] {
    const calls: FetchArgs[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : (input as Request).url;
        const captured: FetchArgs = { url, init: init ?? {} };
        calls.push(captured);
        const r = responder(captured);
        const headers = new Headers(r.headers ?? {});
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        return new Response(JSON.stringify(r.body), { status: r.status, headers });
    }) as typeof fetch;
    (installFetchStub as unknown as { original?: typeof fetch }).original = original;
    return calls;
}

function restoreFetchStub() {
    const original = (installFetchStub as unknown as { original?: typeof fetch }).original;
    if (original) globalThis.fetch = original;
}

describe("registerGetVehicleLocation annotations", () => {
    it("marks the tool read-only and non-destructive so hosts don't prompt for confirmation", () => {
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerGetVehicleLocation(server, client);
        assert.equal(tools.length, 1);
        assert.equal(tools[0]!.name, "get_vehicle_location");
        const annotations = tools[0]!.config.annotations;
        assert.equal(annotations["readOnlyHint"], true);
        assert.equal(annotations["destructiveHint"], false);
        assert.equal(annotations["openWorldHint"], true);
    });
});

describe("registerGetVehicleLocation happy path", () => {
    afterEach(() => restoreFetchStub());

    it("passes latitude, longitude, and locationTimestamp through verbatim", async () => {
        installFetchStub(() => ({
            status: 200,
            body: {
                location: {
                    latitude: 37.7749,
                    longitude: -122.4194,
                    locationTimestamp: "2026-10-24T12:00:00Z",
                },
            },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerGetVehicleLocation(server, client);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, undefined);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["latitude"], 37.7749);
        assert.equal(payload["longitude"], -122.4194);
        assert.equal(payload["locationTimestamp"], "2026-10-24T12:00:00Z");
    });

    it("accepts a response without locationTimestamp (optional field)", async () => {
        installFetchStub(() => ({
            status: 200,
            body: { location: { latitude: 0, longitude: 0 } },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerGetVehicleLocation(server, client);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, undefined);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["latitude"], 0);
        assert.equal(payload["longitude"], 0);
    });

    it("percent-encodes the vehicle id so a crafted path cannot escape", async () => {
        const calls = installFetchStub(() => ({
            status: 200,
            body: { location: { latitude: 0, longitude: 0 } },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerGetVehicleLocation(server, client);
        await tools[0]!.handler({ vehicle_id: "a/b" });
        assert.ok(
            calls[0]!.url.includes("/v1/vehicles/a%2Fb/location"),
            `expected %2F-encoded path, got ${calls[0]!.url}`,
        );
    });
});

describe("registerGetVehicleLocation error path", () => {
    afterEach(() => restoreFetchStub());

    it("returns a tool-error shape with retryAfterSeconds when the backend 503s with Retry-After", async () => {
        installFetchStub(() => ({
            status: 503,
            body: {
                error: "upstream",
                type: "upstream",
                message: "A location request is already in progress; try again in a moment.",
            },
            headers: { "retry-after": "15" },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerGetVehicleLocation(server, client);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, true);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "upstream");
        assert.equal(payload["retryAfterSeconds"], 15);
    });
});
