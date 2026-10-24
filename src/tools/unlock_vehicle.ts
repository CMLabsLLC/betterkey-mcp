import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BetterKeyClient } from "../http.js";
import { toolErrorResult } from "./list_vehicles.js";
import { registerVehicleCommand } from "./_vehicle_command.js";

export function registerUnlockVehicle(server: McpServer, client: BetterKeyClient): void {
    registerVehicleCommand(server, client, {
        toolName: "unlock_vehicle",
        title: "Unlock vehicle",
        command: "unlock",
        path: (id) => `/v1/vehicles/${id}/unlock`,
        description:
            "Unlock the vehicle. This physically actuates the car's door locks and will leave the car unsecured until it is locked again. The agent MUST obtain explicit human confirmation before invoking this tool and should surface a clear reason to the user. The response includes a confirmation field: 'confirmed' means the automaker acknowledged the command; 'unconfirmed' means BetterKey accepted it but the automaker's acknowledgement is unavailable — report that honestly rather than assuming success.",
        toolErrorResult,
        z,
    });
}
