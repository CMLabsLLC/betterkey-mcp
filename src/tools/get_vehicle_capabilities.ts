import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";
import { toolErrorResult } from "./list_vehicles.js";

const VehicleSummary = z.object({
    id: z.string(),
    displayName: z.string(),
    make: z.string(),
    model: z.string(),
    color: z.string().optional().default(""),
});

const ListVehiclesResponse = z.object({
    vehicles: z.array(VehicleSummary),
});

const TelemetryResponse = z.object({
    vehicleId: z.string(),
    capabilities: z.record(z.boolean()),
});

// Static Smartcar/BetterKey quirks the agent should know when reasoning about
// what the car can report. Not derived from the backend; these are
// well-documented upstream behaviors that will not become false between
// requests. Keep this list short — only quirks that would mislead an agent if
// omitted.
const KNOWN_QUIRKS: Array<{ id: string; description: string }> = [
    {
        id: "isLockedWebhookUnreliable",
        description:
            "Smartcar's Closure.IsLocked webhook is known upstream to be unreliable. Any lock-state value in the capabilities map or on past tool calls is last-known, not live. Do not report 'currently locked' with high confidence from a telemetry read; a lock command's response is more reliable than any pushed lock state.",
    },
    {
        id: "statusEndpointReturns501",
        description:
            "BetterKey has no engine-run-state (on/off) tool for Smartcar vehicles; the underlying endpoint returns HTTP 501 Not Implemented for this provider. Do not promise to tell the user whether the engine is running.",
    },
];

export function registerGetVehicleCapabilities(server: McpServer, client: BetterKeyClient): void {
    server.registerTool(
        "get_vehicle_capabilities",
        {
            title: "Get vehicle capabilities",
            description:
                "Describe what BetterKey can currently report for one vehicle: identity (make/model/color), the per-signal freshCapabilities map (true when a fresh reading is available right now), and a knownQuirks list of upstream Smartcar behaviors the agent should respect when reasoning about results.",
            inputSchema: {
                vehicle_id: z.string().min(1).describe("The vehicle id from list_vehicles."),
            },
        },
        async (args) => {
            try {
                const vehicleId = encodeURIComponent(args.vehicle_id);
                const [listRaw, telemetryRaw] = await Promise.all([
                    client.get<unknown>("/v1/vehicles"),
                    client.get<unknown>(`/v1/vehicles/${vehicleId}/telemetry`),
                ]);
                const list = ListVehiclesResponse.parse(listRaw);
                const telemetry = TelemetryResponse.parse(telemetryRaw);
                const summary = list.vehicles.find((v) => v.id === args.vehicle_id);
                const body = {
                    vehicleId: telemetry.vehicleId,
                    provider: "smartcar",
                    identity: summary
                        ? {
                              displayName: summary.displayName,
                              make: summary.make,
                              model: summary.model,
                              color: summary.color,
                          }
                        : null,
                    freshCapabilities: telemetry.capabilities,
                    knownQuirks: KNOWN_QUIRKS,
                };
                return {
                    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
                };
            } catch (err) {
                return toolErrorResult(err);
            }
        },
    );
}
