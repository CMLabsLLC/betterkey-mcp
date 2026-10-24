import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";
import { toolErrorResult } from "./list_vehicles.js";

const LocationResponse = z.object({
    location: z.object({
        latitude: z.number(),
        longitude: z.number(),
        locationTimestamp: z.string().optional(),
    }),
});

export function registerGetVehicleLocation(server: McpServer, client: BetterKeyClient): void {
    server.registerTool(
        "get_vehicle_location",
        {
            title: "Get vehicle location",
            description:
                "Fetch the vehicle's current reported location (latitude, longitude, and the OEM timestamp when known). This is sensitive data — the agent host should treat the result accordingly and should not persist coordinates beyond what the user asked for. Returns 503 with a Retry-After hint when the automaker's location pipe is in-flight or temporarily unavailable; retry only when the user asks.",
            annotations: {
                destructiveHint: false,
                readOnlyHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                vehicle_id: z.string().min(1).describe("The vehicle id from list_vehicles."),
            },
        },
        async (args) => {
            try {
                const vehicleId = encodeURIComponent(args.vehicle_id);
                const raw = await client.get<unknown>(`/v1/vehicles/${vehicleId}/location`);
                const parsed = LocationResponse.parse(raw);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    latitude: parsed.location.latitude,
                                    longitude: parsed.location.longitude,
                                    locationTimestamp: parsed.location.locationTimestamp,
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
