# betterkey-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents inspect **and act on** your [BetterKey](https://betterkey.xyz)-connected vehicles.

Open-source bridge. You mint the key, you keep the control. The server never calls your vehicle's API directly; every request goes to BetterKey's existing `/v1/*` HTTP API over HTTPS, authenticated with an API key you mint in the BetterKey iOS app.

## Tools

Six tools are exposed over stdio:

| Tool | What it does | API-key scope required |
|---|---|---|
| `list_vehicles` | Lists your connected vehicles (id, make, model, color). | `telemetry.read` |
| `get_vehicle_telemetry` | Returns the latest windows/odometer/fuel/battery snapshot with per-signal `oemUpdatedAt` and an `isStale` flag. | `telemetry.read` |
| `get_vehicle_capabilities` | Identity + which signals have fresh data right now + known upstream quirks the agent should respect. | `telemetry.read` |
| `lock_vehicle` | Lock the vehicle. **Destructive**. The agent must obtain explicit human confirmation. Returns `confirmation: "confirmed"` or `"unconfirmed"`. | `vehicle.command` |
| `unlock_vehicle` | Unlock the vehicle. **Destructive**, with the same confirmation and confirmation-status semantics as `lock_vehicle`. | `vehicle.command` |
| `get_vehicle_location` | Current OEM-reported location. Location-sensitive; coordinates are never logged by the server. | `vehicle.command` |

## What it does not do

- It does not read your Firestore directly.
- It does not hold a vehicle-manufacturer OAuth token.
- It does not call the vehicle manufacturer's API itself.
- It does not expose any way to bypass BetterKey's ownership, subscription, or rate-limit checks. Those run server-side on every call.

## Setup

### 1. Mint a BetterKey API key

Open the BetterKey app on iOS → **Settings → API Keys → Create**. Copy the `bk_...` secret immediately; it is shown only once.

**Scopes.** A key minted from the iOS app today holds `telemetry.read + vehicle.command` by default, enough to drive every tool here. If you'd rather keep this bridge read-only (Homebridge-style), mint the key via a direct `POST /v1/account/api-keys` with `{"label":"...","scopes":["telemetry.read"]}`. A read-only key calling a command tool returns a tool-level `insufficient_scope` error naming the missing scope.

### 2. Register with your MCP host

**Claude Desktop.** Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "betterkey": {
      "command": "npx",
      "args": ["-y", "betterkey-mcp"],
      "env": {
        "BETTERKEY_API_KEY": "bk_..."
      }
    }
  }
}
```

Restart Claude Desktop. The six tools should appear in the tool palette.

### 3. Try it

- "List my vehicles."
- "What's the latest telemetry for \<make>?"
- "What can BetterKey tell me about \<make> right now?"
- "Lock \<make>." The agent should confirm with you first; a `confirmation: "unconfirmed"` result means the lock command was accepted by BetterKey but the automaker's acknowledgement is unavailable (the lock may or may not have actuated).
- "Where is \<make>?" Returns latitude/longitude plus the OEM timestamp.

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETTERKEY_API_KEY` | yes | *(none)* | A `bk_...` secret from the BetterKey app. The server refuses to start without one. |
| `BETTERKEY_API_BASE` | no | `https://betterkey.xyz` | Point at `https://staging.betterkey.xyz` for staging, or `http://localhost:8080` when developing against a local BetterKey backend. |

## Revoking access

Agent-host access to your vehicle data lasts only as long as the API key is valid. To revoke:

1. In the BetterKey app → **Settings → API Keys** → delete the key.
2. All subsequent tool calls from the MCP server will fail with `unauthorized`.

To rotate: delete the old key, mint a new one, update `BETTERKEY_API_KEY` in your MCP host config, restart the host.

## Known upstream quirks the agent sees

The `get_vehicle_capabilities` tool returns a `knownQuirks` list so agents don't over-report:

- `isLockedWebhookUnreliable`. The vehicle's upstream lock-state webhook is defective at the provider level; any lock state reported here is last-known, not live.
- `statusEndpointReturns501`. There is no engine-run-state (on/off) tool for your vehicle.

If a tool call returns `401 unauthorized`, the API key was revoked or regenerated. If it returns `403` with `type: "insufficient_scope"` and `requiredScope: "vehicle.command"`, the key does not have the scope the called route requires; mint a new key with that scope and retry.

## Security notes

- The API key lives in your MCP host's env; it is never written to tool output or error messages.
- [Zod](https://zod.dev) validates every tool argument before it reaches the HTTP client.
- All path segments interpolated into URLs go through `encodeURIComponent`.
- Timeouts default to 20s with `Retry-After` honored on 429.
- `fetch` is called with `redirect: "manual"`; redirects fail closed.

## Development

```sh
git clone https://github.com/CMLabsLLC/betterkey-mcp.git
cd betterkey-mcp
npm install
npm run dev        # run with tsx (no build step)
npm run typecheck  # strict typecheck without emit
npm test           # Node's built-in test runner
npm run build      # emit dist/
```

Point at a local backend by setting `BETTERKEY_API_BASE=http://localhost:8080` and running `make simulator-backend` in the main BetterKey repo.

## License

[MIT](./LICENSE)
