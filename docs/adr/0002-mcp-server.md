# ADR 0002 — A small, hand-rolled MCP server

- Status: accepted for M4 (owner confirmation requested; issue #73 named the official SDK)
- Date: 2026-10-01

## Context
Claude Code talks to Social Planner through a local MCP server inside the desktop plugin (spec §6.1). It must bind to 127.0.0.1, require a bearer token, refuse browser traffic (DNS rebinding, CSRF), cap sizes, and never load on phones.

## Decision
Implement Streamable HTTP with JSON responses over Node's `http` module (`src/mcp/server.ts`) and a JSON-RPC dispatcher for `initialize`, `ping`, `tools/list` and `tools/call` (`src/mcp/protocol.ts`). Input schemas come from zod 4's `z.toJSONSchema`.

## Why not `@modelcontextprotocol/sdk`
Checked with version 1.30.1: it bundles with esbuild, but a minimal server adds about 765 KB minified (a zod v3 layer, ajv with runtime code generation, `@hono/node-server`), roughly doubling `main.js`, which phones load too. Its latest protocol revision is 2025-11-25, the same one we implement; the four methods we need are about 100 lines. Owning the HTTP layer lets every security check run before the body is read.

## Consequences
- Supported revisions are pinned in `PROTOCOL_VERSIONS`: 2025-11-25, 2025-06-18, 2025-03-26. No SSE, no sessions, no batches.
- Requests naming another revision (such as 2026-07-28) get `400` with an empty body, so clients that speak both eras fall back to `initialize`.
- If the protocol grows (resources, prompts, the 2026-07-28 revision), revisit this ADR; the SDK can then sit behind the same checks in `server.ts`.

## Deliberate points that must not be "fixed" into regressions (Ruling P8)
- **Batches are always refused** (`400`, `RPC_ERRORS.invalidRequest`), even for a client that negotiated 2025-03-26, which permits JSON-RPC batches: `McpDispatcher.handle` expects a single JSON-RPC object and rejects anything else with `RPC_ERRORS.invalidRequest`, so passing it an array (the whole batch, not "its first item") would not dispatch any of the calls it contains — it would just fail that same object check with a confusing error. Refusing the batch explicitly, before it ever reaches the dispatcher, gives a clearer error instead.
- **Any `Origin` header is refused** (`403`), including one that names `127.0.0.1` or `localhost` itself. This is stricter than the MCP spec's "validate Origin against an allowlist" rule. A real MCP client (Claude Code's Node process) never sets `Origin`; only a browser does, on any cross-origin `fetch`/`XHR`/form POST. Refusing the header outright, rather than trying to allowlist "safe" origins, closes DNS-rebinding and CSRF-style attacks from a page the user has open, with no exception to get wrong later.
- **`REQUEST_TIMEOUT_MS` (30 s) bounds only how long Node waits to receive the request** (`http.Server.requestTimeout`), i.e. the time to read the headers and body. It is not a response deadline: a tool call that is waiting behind an in-Obsidian approval modal (`APPROVAL_TIMEOUT_MS = 120_000`, global-constraints.md) can legitimately take up to two minutes to answer, and this timeout does not cut that wait short.
