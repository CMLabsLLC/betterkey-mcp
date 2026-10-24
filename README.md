# @betterkey/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents inspect **and act on** your BetterKey-connected vehicles.

Six tools are exposed over stdio:

| Tool | What it does | API-key scope required |
|---|---|---|
| `list_vehicles` | Lists your Smartcar-connected vehicles (id, make, model, color). | `telemetry.read` |
| `get_vehicle_telemetry` | Returns the latest windows/odometer/fuel/battery snapshot with per-signal `oemUpdatedAt` and an `isStale` flag. | `telemetry.read` |
| `get_vehicle_capabilities` | Identity + which signals have fresh data right now + known upstream Smartcar quirks the agent should respect. | `telemetry.read` |
| `lock_vehicle` | Lock the vehicle. **Destructive** — the agent must obtain explicit human confirmation. Returns `confirmation: "confirmed"` or `"unconfirmed"`. | `vehicle.command` |
| `unlock_vehicle` | Unlock the vehicle. **Destructive** — same confirmation + confirmation-status semantics as `lock_vehicle`. | `vehicle.command` |
| `get_vehicle_location` | Current OEM-reported location. Location-sensitive; coordinates are never logged by the server. | `vehicle.command` |

## What it does not do

- It does not read your Firestore directly.
- It does not hold a Smartcar OAuth token.
- It does not call Smartcar's API itself.
- It does not expose any way to send a vehicle command.

Every request goes to BetterKey's existing `/v1/*` HTTP API over HTTPS, authenticated with a BetterKey API key you mint. Ownership, subscription, and per-key rate limiting are enforced server-side on every call.

## Setup

### 1. Mint a BetterKey API key

Open the BetterKey app on iOS → Settings → API Keys → Create. Copy the `bk_...` secret immediately; it is shown only once.

**Scopes**: a key minted from the iOS app today holds `telemetry.read` only. To call `lock_vehicle`, `unlock_vehicle`, or `get_vehicle_location`, mint the key with the `vehicle.command` scope — either via a direct POST to `/v1/account/api-keys` with `{"label":"...","scopes":["telemetry.read","vehicle.command"]}`, or wait for the iOS UI to expose a scope picker. A read-only key calling a command tool gets a tool-level `insufficient_scope` error naming the missing scope.

### 2. Install the server

```sh
cd mcp/betterkey-mcp
npm install
npm run build
```

### 3. Register with your MCP host

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "betterkey": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/betterkey-mcp/dist/index.js"],
      "env": {
        "BETTERKEY_API_KEY": "bk_...",
        "BETTERKEY_API_BASE": "https://api.betterkey.xyz"
      }
    }
  }
}
```

Restart Claude Desktop. The three tools should appear in the tool palette.

### 4. Try it

- "List my vehicles."
- "What's the latest telemetry for \<make>?"
- "What can BetterKey tell me about \<make> right now?"
- "Lock \<make>." — the agent should confirm with you first; a `confirmation: "unconfirmed"` result means the lock command was accepted by BetterKey but the automaker's acknowledgement is unavailable (the lock may or may not have actuated).
- "Where is \<make>?" — returns latitude/longitude plus the OEM timestamp.

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETTERKEY_API_KEY` | yes | — | A `bk_...` secret from the BetterKey app. The server refuses to start without one. |
| `BETTERKEY_API_BASE` | no | `https://api.betterkey.xyz` | Point at `http://localhost:8080` for local dev with `make simulator-backend`. |

## Revoking access

The agent host can access your vehicle data only as long as the API key is valid. To revoke:

1. In the BetterKey app → Settings → API Keys → delete the key.
2. All subsequent tool calls from the MCP server will fail with `unauthorized`.

To rotate: delete the old key, mint a new one, update `BETTERKEY_API_KEY` in your MCP host config, restart the host.

## Known Smartcar quirks the agent sees

The `get_vehicle_capabilities` tool returns a `knownQuirks` list so agents don't over-report:

- `isLockedWebhookUnreliable` — Smartcar's `Closure.IsLocked` webhook is upstream-defective; any lock state reported here is last-known, not live.
- `statusEndpointReturns501` — there is no engine-run-state (on/off) tool for Smartcar vehicles.

If a tool call returns 401 `unauthorized`, the API key was revoked or regenerated. If it returns 403 with `type: "insufficient_scope"` and `requiredScope: "vehicle.command"`, the key does not have the scope the called route requires — mint a new key with that scope and retry.

## Security notes

- The API key lives in your MCP host's env; it is never written to tool output or error messages.
- Zod validates every tool argument before it reaches the HTTP client.
- All path segments interpolated into URLs go through `encodeURIComponent`.
- Timeouts default to 20s with `Retry-After` honored on 429.

## Development

```sh
npm run dev        # run with tsx (no build step)
npm run typecheck  # strict typecheck without emit
npm run build      # emit dist/
```

## Status

Stage 2 — command and location tools shipped behind the `vehicle.command` scope. Follow-ups (hosted HTTP transport, developer CLI, published npm) are revisited only if the current surface produces real agent-task value.
