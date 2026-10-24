#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BetterKeyClient } from "./http.js";
import { registerListVehicles } from "./tools/list_vehicles.js";
import { registerGetVehicleTelemetry } from "./tools/get_vehicle_telemetry.js";
import { registerGetVehicleCapabilities } from "./tools/get_vehicle_capabilities.js";
import { registerLockVehicle } from "./tools/lock_vehicle.js";
import { registerUnlockVehicle } from "./tools/unlock_vehicle.js";
import { registerGetVehicleLocation } from "./tools/get_vehicle_location.js";

const SERVER_NAME = "betterkey-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_API_BASE = "https://api.betterkey.xyz";

async function main(): Promise<void> {
    const apiKey = process.env.BETTERKEY_API_KEY;
    const apiBase = process.env.BETTERKEY_API_BASE ?? DEFAULT_API_BASE;

    if (!apiKey || apiKey.trim() === "") {
        process.stderr.write(
            "betterkey-mcp: BETTERKEY_API_KEY is required. Mint one in the BetterKey app's API Keys screen and set the env var in your MCP client's configuration.\n",
        );
        process.exit(1);
    }

    const client = new BetterKeyClient({
        apiKey,
        baseUrl: apiBase,
        userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
    });

    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });

    registerListVehicles(server, client);
    registerGetVehicleTelemetry(server, client);
    registerGetVehicleCapabilities(server, client);
    registerLockVehicle(server, client);
    registerUnlockVehicle(server, client);
    registerGetVehicleLocation(server, client);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`betterkey-mcp: fatal: ${msg}\n`);
    process.exit(1);
});
