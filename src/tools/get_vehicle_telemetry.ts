import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";
import { toolErrorResult } from "./list_vehicles.js";

const SignalEnvelope = z.object({
    oemUpdatedAt: z.string().optional(),
    retrievedAt: z.string().optional(),
}).passthrough();

const TelemetryResponse = z.object({
    vehicleId: z.string(),
    capabilities: z.record(z.boolean()),
    signals: z.record(SignalEnvelope).optional(),
});

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export function registerGetVehicleTelemetry(server: McpServer, client: BetterKeyClient): void {
    server.registerTool(
        "get_vehicle_telemetry",
        {
            title: "Get vehicle telemetry",
            description:
                "Fetch the latest telemetry snapshot (windows, odometer, fuel, battery) for one vehicle. Each returned signal carries oemUpdatedAt from the automaker and an isStale flag (true when the reading is older than 15 minutes). Pass refresh=true to bypass the server's 15-minute cache; most calls should leave it false.",
            inputSchema: {
                vehicle_id: z.string().min(1).describe("The vehicle id from list_vehicles."),
                refresh: z
                    .boolean()
                    .optional()
                    .describe("If true, bypass the server-side 15 min signal cache. Default false."),
            },
        },
        async (args) => {
            try {
                const vehicleId = encodeURIComponent(args.vehicle_id);
                const query = args.refresh ? { refresh: "true" } : undefined;
                const raw = await client.get<unknown>(`/v1/vehicles/${vehicleId}/telemetry`, query);
                const parsed = TelemetryResponse.parse(raw);
                const now = Date.now();
                const signalsWithStaleness: Record<string, unknown> = {};
                for (const [name, signal] of Object.entries(parsed.signals ?? {})) {
                    signalsWithStaleness[name] = {
                        ...signal,
                        isStale: isStale(signal.oemUpdatedAt, now),
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    vehicleId: parsed.vehicleId,
                                    capabilities: parsed.capabilities,
                                    signals: signalsWithStaleness,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (err) {
                return toolErrorResult(err);
            }
        },
    );
}

export function isStale(oemUpdatedAt: string | undefined, now: number): boolean {
    if (!oemUpdatedAt) return true;
    const parsed = Date.parse(oemUpdatedAt);
    if (!Number.isFinite(parsed)) return true;
    return now - parsed > STALE_THRESHOLD_MS;
}
