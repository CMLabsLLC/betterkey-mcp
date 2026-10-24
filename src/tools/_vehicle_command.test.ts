import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BetterKeyClient } from "../http.ts";
import { registerVehicleCommand } from "./_vehicle_command.ts";
import { toolErrorResult } from "./list_vehicles.ts";

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

const lockOptions = {
    toolName: "lock_vehicle" as const,
    title: "Lock vehicle",
    command: "lock" as const,
    path: (id: string) => `/v1/vehicles/${id}/lock`,
    description: "test description",
    toolErrorResult,
    z,
};

describe("registerVehicleCommand annotations", () => {
    it("sets destructiveHint, openWorldHint, idempotentHint for safety-critical tools", () => {
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        assert.equal(tools.length, 1);
        assert.equal(tools[0]!.name, "lock_vehicle");
        const annotations = tools[0]!.config.annotations;
        assert.equal(
            annotations["destructiveHint"],
            true,
            "lock_vehicle must be destructive-hinted so hosts prompt for confirmation",
        );
        assert.equal(annotations["openWorldHint"], true);
        assert.equal(annotations["idempotentHint"], false);
    });
});

describe("registerVehicleCommand confirmation surfacing", () => {
    afterEach(() => restoreFetchStub());

    it("reports confirmed when the backend returns the x-command-confirmation header", async () => {
        installFetchStub(() => ({
            status: 200,
            body: { status: "success", vehicleId: "v1", command: "lock" },
            headers: { "x-command-confirmation": "confirmed", "x-operation-id": "op-1" },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, undefined);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["confirmation"], "confirmed");
        assert.equal(payload["operationId"], "op-1");
        assert.equal(payload["command"], "lock");
    });

    it("reports unconfirmed when the backend header says so (upstream 5xx fallback)", async () => {
        installFetchStub(() => ({
            status: 200,
            body: { status: "accepted", vehicleId: "v1", command: "lock" },
            headers: {
                "x-command-confirmation": "unconfirmed",
                "x-smartcar-upstream-status": "502",
            },
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(
            payload["confirmation"],
            "unconfirmed",
            "the agent must see unconfirmed, not confirmed by default",
        );
        assert.equal(payload["upstreamStatus"], "502");
    });

    it("falls back to body.confirmation when the header is absent", async () => {
        installFetchStub(() => ({
            status: 200,
            body: {
                status: "success",
                vehicleId: "v1",
                command: "lock",
                confirmation: "unconfirmed",
            },
            headers: {},
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["confirmation"], "unconfirmed");
    });

    it("defaults to confirmed when neither header nor body field is present", async () => {
        installFetchStub(() => ({
            status: 200,
            body: { status: "success", vehicleId: "v1", command: "lock" },
            headers: {},
        }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["confirmation"], "confirmed");
    });
});

describe("registerVehicleCommand URL encoding", () => {
    afterEach(() => restoreFetchStub());

    it("percent-encodes slashes in vehicle_id so a crafted id cannot escape the path", async () => {
        const calls = installFetchStub(() => ({ status: 200, body: {}, headers: {} }));
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        await tools[0]!.handler({ vehicle_id: "a/b" });
        assert.equal(calls.length, 1);
        assert.ok(
            calls[0]!.url.includes("/v1/vehicles/a%2Fb/lock"),
            `expected %2F-encoded path, got ${calls[0]!.url}`,
        );
        assert.ok(
            !calls[0]!.url.includes("/v1/vehicles/a/b/lock"),
            "raw slash must not pass through",
        );
    });
});

describe("registerVehicleCommand error path", () => {
    afterEach(() => restoreFetchStub());

    it("returns a tool-error shape on insufficient_scope rather than throwing", async () => {
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
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerVehicleCommand(server, client, lockOptions);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, true);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "insufficient_scope");
        assert.equal(payload["requiredScope"], "vehicle.command");
        assert.deepEqual(payload["grantedScopes"], ["telemetry.read"]);
    });
});
