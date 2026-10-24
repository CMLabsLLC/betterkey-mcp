import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BetterKeyApiError } from "../http.ts";
import { toolErrorResult } from "./list_vehicles.ts";

describe("toolErrorResult", () => {
    it("surfaces requiredScope, grantedScopes, and a hint for insufficient_scope", () => {
        const err = new BetterKeyApiError(
            403,
            "insufficient_scope",
            "The API key does not grant the required scope.",
            {
                error: "insufficient_scope",
                type: "insufficient_scope",
                message: "nope",
                required: "vehicle.command",
                granted: ["telemetry.read"],
            },
        );
        const result = toolErrorResult(err);
        assert.equal(result.isError, true);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "insufficient_scope");
        assert.equal(payload["requiredScope"], "vehicle.command");
        assert.deepEqual(payload["grantedScopes"], ["telemetry.read"]);
        const hint = payload["hint"];
        assert.ok(
            typeof hint === "string" && hint.includes("vehicle.command"),
            `hint should name the required scope, got ${String(hint)}`,
        );
    });

    it("omits scope fields when the payload has no required/granted", () => {
        const err = new BetterKeyApiError(403, "forbidden", "forbidden", { error: "forbidden" });
        const result = toolErrorResult(err);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal("requiredScope" in payload, false);
        assert.equal("grantedScopes" in payload, false);
    });

    it("passes retryAfterSeconds through when present on the error", () => {
        const err = new BetterKeyApiError(429, "rate_limit", "too many", {}, 30);
        const result = toolErrorResult(err);
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["retryAfterSeconds"], 30);
    });

    it("falls back to a generic internal error shape for non-BetterKeyApiError throws", () => {
        const result = toolErrorResult(new Error("boom"));
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "internal");
        assert.equal(payload["message"], "boom");
    });

    it("stringifies non-Error throws without crashing", () => {
        const result = toolErrorResult("thrown string");
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        assert.equal(payload["type"], "internal");
        assert.equal(payload["message"], "thrown string");
    });
});
