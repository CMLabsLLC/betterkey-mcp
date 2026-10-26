import type { z as ZodNamespace } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BetterKeyApiError, COMMAND_TIMEOUT_MS, type BetterKeyClient } from "../http.js";

// COMMAND_TIMEOUT_MESSAGE is returned when a lock/unlock call aborts at the client
// timeout. The backend does not cancel on its own at that point and the OEM may still
// actuate the car, so retrying would double-fire. Naming get_vehicle_telemetry makes it
// likely the agent polls to verify instead of narrating "may or may not have actuated".
const COMMAND_TIMEOUT_MESSAGE =
    "Command dispatched to the vehicle but no confirmation received within 60s. The backend keeps processing after this timeout and the vehicle may still actuate — call get_vehicle_telemetry to verify the current lock state before retrying, since retrying would risk double-firing the command.";

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
                const result = await client.postWithHeaders<CommandResponseShape>(
                    path(vehicleId),
                    undefined,
                    { timeoutMs: COMMAND_TIMEOUT_MS },
                );
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
                if (err instanceof BetterKeyApiError && err.type === "timeout") {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        error: true,
                                        type: "timeout",
                                        status: 0,
                                        command,
                                        vehicleId: args.vehicle_id,
                                        confirmation: "unconfirmed",
                                        message: COMMAND_TIMEOUT_MESSAGE,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
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
