import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BetterKeyApiError, BetterKeyClient, COMMAND_TIMEOUT_MS, READ_TIMEOUT_MS } from "./http.ts";
import { registerListVehicles } from "./tools/list_vehicles.ts";
import { registerGetVehicleTelemetry } from "./tools/get_vehicle_telemetry.ts";
import { registerGetVehicleLocation } from "./tools/get_vehicle_location.ts";
import { registerLockVehicle } from "./tools/lock_vehicle.ts";
import { registerUnlockVehicle } from "./tools/unlock_vehicle.ts";

// These tests pin the per-tool fetch deadline each MCP tool uses when calling the
// BetterKey backend. The split exists because lock/unlock/location round-trip through
// Smartcar to the OEM and routinely take longer than 20s, while list/telemetry are
// cheap backend-only reads. Collapsing these back to one global timeout would
// reintroduce the "timeout even though the car actuated" bug from the field report.

type CapturedTool = {
    name: string;
    handler: (args: { vehicle_id: string }) => Promise<{
        isError?: boolean;
        content: Array<{ type: "text"; text: string }>;
    }>;
};

function stubMcpServer() {
    const tools: CapturedTool[] = [];
    const server = {
        registerTool: (name: string, _config: unknown, handler: unknown) => {
            tools.push({ name, handler: handler as CapturedTool["handler"] });
        },
    } as unknown as McpServer;
    return { server, tools };
}

function installFetchStub(status = 200, body: unknown = { vehicles: [] }) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
        const headers = new Headers({ "content-type": "application/json" });
        return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;
    (installFetchStub as unknown as { original?: typeof fetch }).original = original;
}

function restoreFetchStub() {
    const original = (installFetchStub as unknown as { original?: typeof fetch }).original;
    if (original) globalThis.fetch = original;
}

// spySetTimeout records the delay value of every setTimeout call made during a block.
// The MCP client's fetch wrapper schedules exactly one setTimeout per request (the
// abort timer), so the recorded delays are what the production code considers the
// deadline for that request. Spying is lighter than mock timers and does not change
// scheduling, so handlers settle normally for the happy-path assertions below.
function spySetTimeout(): { delays: number[]; restore: () => void } {
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
        if (typeof delay === "number") delays.push(delay);
        return original(fn, delay, ...(rest as [])) as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;
    return {
        delays,
        restore: () => {
            globalThis.setTimeout = original;
        },
    };
}

async function timeoutDelayFor(register: (s: McpServer, c: BetterKeyClient) => void): Promise<number> {
    installFetchStub(200, {
        vehicles: [],
        vehicleId: "v1",
        capabilities: {},
        signals: {},
        location: { latitude: 0, longitude: 0 },
    });
    const spy = spySetTimeout();
    try {
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        register(server, client);
        await tools[0]!.handler({ vehicle_id: "v1" });
    } finally {
        spy.restore();
        restoreFetchStub();
    }
    // One registered handler → one backend call → exactly one scheduled abort timer.
    // get_vehicle_capabilities issues two concurrent calls so it is deliberately not
    // covered here; the per-call timeout contract it depends on is the client default
    // asserted separately in "default read timeout" below.
    assert.equal(spy.delays.length, 1, `expected one fetch-abort timer, saw ${spy.delays.length}`);
    return spy.delays[0]!;
}

describe("per-tool fetch deadlines", () => {
    afterEach(() => restoreFetchStub());

    it("exports distinct read and command timeout constants", () => {
        assert.equal(READ_TIMEOUT_MS, 20_000, "list/telemetry stay on the short read deadline");
        assert.equal(COMMAND_TIMEOUT_MS, 60_000, "lock/unlock/location need the long Smartcar deadline");
        assert.ok(COMMAND_TIMEOUT_MS > READ_TIMEOUT_MS, "command timeout must exceed read timeout");
    });

    it("list_vehicles uses the 20s read timeout", async () => {
        const delay = await timeoutDelayFor(registerListVehicles);
        assert.equal(delay, READ_TIMEOUT_MS);
    });

    it("get_vehicle_telemetry uses the 20s read timeout", async () => {
        const delay = await timeoutDelayFor(registerGetVehicleTelemetry);
        assert.equal(delay, READ_TIMEOUT_MS);
    });

    it("lock_vehicle uses the 60s command timeout", async () => {
        const delay = await timeoutDelayFor(registerLockVehicle);
        assert.equal(delay, COMMAND_TIMEOUT_MS);
    });

    it("unlock_vehicle uses the 60s command timeout", async () => {
        const delay = await timeoutDelayFor(registerUnlockVehicle);
        assert.equal(delay, COMMAND_TIMEOUT_MS);
    });

    it("get_vehicle_location uses the 60s command timeout (blocks on Smartcar like a command)", async () => {
        const delay = await timeoutDelayFor(registerGetVehicleLocation);
        assert.equal(delay, COMMAND_TIMEOUT_MS);
    });
});

describe("BetterKeyClient per-request timeout override", () => {
    afterEach(() => restoreFetchStub());

    it("defaults to the 20s read timeout when no override is passed", () => {
        installFetchStub();
        const spy = spySetTimeout();
        try {
            const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
            void client.get("/v1/vehicles");
            assert.equal(spy.delays[0], READ_TIMEOUT_MS);
        } finally {
            spy.restore();
        }
    });

    it("honors a per-call timeoutMs override", () => {
        installFetchStub();
        const spy = spySetTimeout();
        try {
            const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
            void client.postWithHeaders("/v1/vehicles/v1/lock", undefined, { timeoutMs: COMMAND_TIMEOUT_MS });
            assert.equal(spy.delays[0], COMMAND_TIMEOUT_MS);
        } finally {
            spy.restore();
        }
    });

    it("surfaces the override value in the timeout error message", async () => {
        installAbortingFetch();
        try {
            const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
            await assert.rejects(
                () => client.get("/v1/vehicles", undefined, { timeoutMs: 10 }),
                (err: unknown) => {
                    assert.ok(err instanceof BetterKeyApiError);
                    const e = err as BetterKeyApiError;
                    assert.equal(e.type, "timeout");
                    assert.match(e.message, /10ms/);
                    return true;
                },
            );
        } finally {
            restoreFetchStub();
        }
    });
});

describe("command tools timeout error surfacing", () => {
    afterEach(() => restoreFetchStub());

    it("lock_vehicle returns a timeout result that names get_vehicle_telemetry and tells the agent not to retry", async () => {
        installAbortingFetch();
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerLockVehicle(server, client);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, true);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "timeout");
        assert.equal(payload["confirmation"], "unconfirmed");
        assert.equal(payload["command"], "lock");
        const message = String(payload["message"]);
        assert.match(message, /get_vehicle_telemetry/, "message must name the telemetry tool by its exact id");
        assert.match(message, /may still actuate/i, "message must explain the vehicle may still actuate");
        assert.match(message, /double-fir/i, "message must warn the agent not to retry");
    });

    it("unlock_vehicle returns the same timeout contract", async () => {
        installAbortingFetch();
        const { server, tools } = stubMcpServer();
        const client = new BetterKeyClient({ apiKey: "bk_x", baseUrl: "http://local" });
        registerUnlockVehicle(server, client);
        const result = await tools[0]!.handler({ vehicle_id: "v1" });
        assert.equal(result.isError, true);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["command"], "unlock");
        assert.equal(payload["confirmation"], "unconfirmed");
        assert.match(String(payload["message"]), /get_vehicle_telemetry/);
    });
});

// installAbortingFetch returns a fetch that rejects immediately with an AbortError-
// shaped Error. The client treats that identically to its own abort firing, so the
// timeout path can be exercised without actually waiting for the per-call deadline.
function installAbortingFetch() {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
    }) as typeof fetch;
    (installFetchStub as unknown as { original?: typeof fetch }).original = original;
}
