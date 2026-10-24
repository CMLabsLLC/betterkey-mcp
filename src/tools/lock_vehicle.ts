import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";
import { toolErrorResult } from "./list_vehicles.js";
import { registerVehicleCommand } from "./_vehicle_command.js";

export function registerLockVehicle(server: McpServer, client: BetterKeyClient): void {
    registerVehicleCommand(server, client, {
        toolName: "lock_vehicle",
        title: "Lock vehicle",
        command: "lock",
        path: (id) => `/v1/vehicles/${id}/lock`,
        description:
            "Lock the vehicle. This physically actuates the car's door locks. The agent MUST obtain explicit human confirmation before invoking this tool. The response includes a confirmation field: 'confirmed' means the automaker acknowledged the command; 'unconfirmed' means BetterKey accepted it but the automaker's acknowledgement is unavailable (the lock may or may not have actuated) — report that honestly rather than assuming success.",
        toolErrorResult,
        z,
    });
}
