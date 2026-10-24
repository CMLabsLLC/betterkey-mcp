import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BetterKeyApiError, BetterKeyClient, redactApiKey } from "./http.ts";
import { isStale } from "./tools/get_vehicle_telemetry.ts";

describe("BetterKeyClient", () => {
    it("rejects construction without an API key", () => {
        assert.throws(() => new BetterKeyClient({ apiKey: "", baseUrl: "http://x" }), /API_KEY/);
        assert.throws(() => new BetterKeyClient({ apiKey: "   ", baseUrl: "http://x" }), /API_KEY/);
    });

    it("rejects construction without a base URL", () => {
        assert.throws(() => new BetterKeyClient({ apiKey: "bk_x", baseUrl: "" }), /API_BASE/);
    });
});

describe("redactApiKey", () => {
    it("replaces the full key with a prefix placeholder", () => {
        const key = "bk_abcdef1234567890";
        const redacted = redactApiKey(`error with ${key} in it`, key);
        assert.ok(!redacted.includes(key), "redacted output must not contain the full key");
        assert.ok(redacted.includes("bk_a…[redacted]"));
    });

    it("is a no-op when the key is not present", () => {
        const key = "bk_abc";
        assert.equal(redactApiKey("plain error", key), "plain error");
    });
});

describe("BetterKeyApiError", () => {
    it("captures status, type, and payload", () => {
        const err = new BetterKeyApiError(429, "rate_limit", "too many", { message: "too many" }, 30);
        assert.equal(err.status, 429);
        assert.equal(err.type, "rate_limit");
        assert.equal(err.retryAfterSeconds, 30);
        assert.equal(err.message, "too many");
    });
});

describe("isStale", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");

    it("flags missing timestamps as stale", () => {
        assert.equal(isStale(undefined, now), true);
    });

    it("flags unparseable timestamps as stale", () => {
        assert.equal(isStale("not-a-date", now), true);
    });

    it("flags readings older than 15 minutes as stale", () => {
        const sixteenMinAgo = new Date(now - 16 * 60 * 1000).toISOString();
        assert.equal(isStale(sixteenMinAgo, now), true);
    });

    it("flags readings within 15 minutes as fresh", () => {
        const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
        assert.equal(isStale(fiveMinAgo, now), false);
    });

    it("counts future-skewed readings as fresh", () => {
        const oneMinFuture = new Date(now + 60 * 1000).toISOString();
        assert.equal(isStale(oneMinFuture, now), false);
    });
});
