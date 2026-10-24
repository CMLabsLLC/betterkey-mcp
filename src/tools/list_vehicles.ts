import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BetterKeyApiError, httpErrorHint, type BetterKeyClient } from "../http.js";

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

export function registerListVehicles(server: McpServer, client: BetterKeyClient): void {
    server.registerTool(
        "list_vehicles",
        {
            title: "List vehicles",
            description:
                "List the user's Smartcar-connected vehicles in BetterKey. Returns id, display name, make, model, and exterior color. Use the id as the vehicle_id argument to other tools.",
            inputSchema: {},
        },
        async () => {
            try {
                const raw = await client.get<unknown>("/v1/vehicles");
                const parsed = ListVehiclesResponse.parse(raw);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ vehicles: parsed.vehicles }, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return toolErrorResult(err);
            }
        },
    );
}

export function toolErrorResult(err: unknown) {
    if (err instanceof BetterKeyApiError) {
        const body: Record<string, unknown> = {
            error: true,
            type: err.type,
            status: err.status,
            message: err.message,
        };
        if (err.retryAfterSeconds !== undefined) body.retryAfterSeconds = err.retryAfterSeconds;
        const requiredScope =
            typeof err.payload["required"] === "string" ? (err.payload["required"] as string) : undefined;
        if (requiredScope) body.requiredScope = requiredScope;
        const granted = err.payload["granted"];
        if (Array.isArray(granted)) body.grantedScopes = granted;
        const hint = httpErrorHint(err.type, requiredScope);
        if (hint) body.hint = hint;
        return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: true, type: "internal", message }, null, 2) }],
    };
}
