# Changelog

All notable changes to `@betterkey/mcp` are documented here. This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 — Initial public release

Six tools over stdio:

- `list_vehicles` — list Smartcar-connected vehicles.
- `get_vehicle_telemetry` — latest windows, odometer, fuel, battery with per-signal freshness.
- `get_vehicle_capabilities` — identity, fresh-signal set, and known upstream quirks.
- `lock_vehicle` — lock a vehicle. Requires explicit human confirmation.
- `unlock_vehicle` — unlock a vehicle. Requires explicit human confirmation.
- `get_vehicle_location` — current OEM-reported location.

Code moved from `CMLabsLLC/betterkey/mcp/betterkey-mcp` with git history preserved via `git subtree split`.
