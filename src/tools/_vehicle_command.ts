import type { z as ZodNamespace } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";

export interface VehicleCommandOptions {
    toolName: "lock_vehicle" | "unlock_vehicle";
    title: string;
    command: "lock" | "unlock";
    path: (vehicleId: string) => string;
    description: string;
    toolErrorResult: (err: unknown) => {
        isError: boolean;
        content: Array<{ type: "text"; text: string }>;
    };
    z: typeof ZodNamespace;
}

// registerVehicleCommand factors the shared machinery for lock_vehicle and unlock_vehicle:
// identical input schema, destructiveHint, output shape (body + exposed headers), and
// error handling. Each command tool is a thin shell around this so the "confirmed vs
// unconfirmed" surfacing cannot drift between lock and unlock.
export function registerVehicleCommand(
    server: McpServer,
    client: BetterKeyClient,
    opts: VehicleCommandOptions,
): void {
    const { toolName, title, command, path, description, toolErrorResult, z } = opts;

    server.registerTool(
        toolName,
        {
            title,
            description,
            annotations: {
                destructiveHint: true,
                openWorldHint: true,
                idempotentHint: false,
            },
            inputSchema: {
                vehicle_id: z.string().min(1).describe("The vehicle id from list_vehicles."),
            },
        },
        async (args) => {
            try {
                const vehicleId = encodeURIComponent(args.vehicle_id);
                const result = await client.postWithHeaders<CommandResponseShape>(path(vehicleId));
                // Fail-safe: when the backend returns 2xx but gives us no explicit
                // confirmation marker (neither the x-command-confirmation header nor
                // the body.confirmation field), surface "unconfirmed" rather than
                // defaulting to "confirmed". The product promise is that the agent
                // reports uncertainty honestly; defaulting to confirmed on a missing
                // marker would silently violate that if backend contract ever drifts.
                const confirmation =
                    result.headers["x-command-confirmation"] ??
                    (typeof result.body.confirmation === "string" ? result.body.confirmation : "unconfirmed");
                const output = {
                    status: result.body.status ?? "success",
                    command,
                    vehicleId: result.body.vehicleId ?? args.vehicle_id,
                    confirmation,
                    message: result.body.message,
                    operationId: result.headers["x-operation-id"],
                    upstreamStatus: result.headers["x-smartcar-upstream-status"],
                };
                return {
                    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
                };
            } catch (err) {
                return toolErrorResult(err);
            }
        },
    );
}

// CommandResponseShape describes the subset of the backend's lock/unlock JSON the tool
// surfaces to the agent. All fields are optional because the backend uses two shapes (the
// confirmed success and the "unconfirmed" fallback) and we accept either.
interface CommandResponseShape {
    status?: string;
    message?: string;
    vehicleId?: string;
    command?: string;
    confirmation?: string;
    result?: string;
}
