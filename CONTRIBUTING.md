# Contributing

Thanks for your interest in `betterkey-mcp`.

This repository is actively maintained by [BetterKey](https://betterkey.xyz). The six tools exposed here are tightly coupled to the shape of the BetterKey HTTP API, so most feature work needs a coordinated change on the server side first.

## Issues

Bug reports and feature requests are welcome. Please include:

- The MCP host (Claude Desktop, Zed, custom, etc.) and its version.
- The output of `npx -y betterkey-mcp --version` (or your pinned version).
- `BETTERKEY_API_BASE` if you're pointing somewhere other than production.
- Enough of a transcript to reproduce the behavior. The server never logs your API key or vehicle coordinates; redact any output you don't want public before pasting.

Security issues: please email `security@betterkey.xyz` instead of filing a public issue.

## Pull requests

PRs are reviewed at maintainer discretion. If you're planning a non-trivial change, open an issue first so we can confirm the shape of the backend contract supports it. CI runs typecheck + the existing test suite on every PR; please add tests for new behavior.

## Local development

```sh
npm install
npm run dev        # run with tsx (no build step)
npm run typecheck
npm test
```

Point at a local backend by setting `BETTERKEY_API_BASE=http://localhost:8080`.
