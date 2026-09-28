# M4 — Claude Code MCP Server and the /social Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code can read the plan, draft, validate and schedule posts, and (only after the user approves in Obsidian) publish, through a local MCP server inside the desktop plugin; a `/social` skill shipped from this repo as a Claude Code plugin turns one conversation into a scheduled campaign, using platform playbooks and the user's voice profile, and falls back to writing notes directly when Obsidian is closed.

**Architecture:** `src/mcp/` holds a small hand-rolled MCP server: `tools.ts` (a registry that validates arguments with zod 4, returns structured results and redacts secrets), `protocol.ts` (JSON-RPC 2.0 dispatcher for the initialize-based MCP revisions 2025-03-26 to 2025-11-25), `server.ts` (Node `http` on 127.0.0.1 only, with the bearer-token, Host, Origin, loopback, method, content-type and size checks done before any parsing) and `service.ts` (start/stop from device-local settings, token in `secretStorage`, status store). Node's `http` is loaded with a dynamic `import("node:http")` only when the server starts on a desktop app, so phones never load it. Tools live in `src/mcp/tools/*.ts` and only call existing services (`NoteFactory`, `SafeWriter` through `PlannerActions.write`, `ComposerActions.check`, `PublishActions`), so every write keeps the M1–M3 rules. Publish tools go through an `ApprovalGate` (an Obsidian modal, 2-minute timeout, per-channel "publish without asking"), then P3 (flush, re-validate, compare with what was approved) before anything is sent. The skill and playbooks live in `claude-plugin/` with a marketplace file at the repo root; tests keep their numbers, examples and tool names in step with the code.

**Tech Stack:** TypeScript 5.9 (strict), Svelte 5 (runes), Obsidian API 1.13 (`Platform`, `Modal`, `SecretStorage`, `Vault.process`), Node `http` (desktop only), zod 4.6 (`z.toJSONSchema`), MCP Streamable HTTP (JSON responses), Claude Code plugin and marketplace format, Vitest 5 (jsdom) with the in-memory Obsidian fake.

**Spec:** `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` (§1.2, §1.3.4–5, §2.5 `_voice.md`, §2.6 secrets, §3 view 1 "MCP status light", §4 `mcp` module, §5.1–5.2, §5.5, §6.1 MCP server, §6.2 `/social` skill, §7 "MCP: every tool runs against an in-memory vault; publish tools stay blocked until approved", §8 M4). Mockups: https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z. Binding rulings: `.superpowers/sdd/2026-09-30-m3-reminders-and-publisher-device/progress.md` (P1–P14 and the Task-N rulings) and the M2a/M2b ledgers it reproduces (P1–P5).

**Depends on:** M3 complete on `feat/m3-reminders-and-publisher-device` (HEAD `390b154`, 967 tests green). Work on a new branch `feat/m4-claude-code` created from that HEAD.

**Issues covered:** epic #72 — #73 (Tasks 1–3), #74 (Task 4), #75 (Tasks 5–6), #76 (Task 7), #77 (Task 8), #78 (Task 9) · epic #79 — #84 plugin side (Task 10), #80 (Task 11), #81 (Tasks 11–12), #84 skill side (Task 12), #82 (Task 13), #83 and #85 (Task 14) · docs and acceptance (Task 15).

**Not pre-verified:** the code was written against the current source (read file by file at `390b154`) but not applied to a scratch copy. Where a signature in the repo differs from what a step shows, make the minimal correction and report it in the task's review notes. Items marked **(QA)** depend on external tools (Claude Code, its plugin format) that could not be run here; Task 15 lists them in `docs/qa/m4.md`.

## Global Constraints

- All M1–M3 constraints apply: `SafeWriter` for every frontmatter write, per key (never a whole `deliveries` map); `transition()` for every status change; fresh-frontmatter plans inside `updateVariant` / `PlannerActions.write`; real controls, `setIcon`, Obsidian CSS variables, **no emoji anywhere in the UI** (modal, notices, settings, status light, ntfy); `TZ=Europe/Berlin` in tests.
- **Unreadable delivery entries stay frozen** (`invalidDeliveries`): no MCP tool publishes, schedules, forks, removes or overwrites them. **`publishing` and `check_needed` are never auto-retried** (P4): publish tools use `assistedQueue`, which leaves them out. **P3:** before anything is sent, flush the open editor, re-validate the exact text and refuse on blocking issues. **Only the publisher device dispatches** (spec §4.3): API sends from `publish_now`/`push_update` are refused on other devices.
- **Secrets only in `app.secretStorage`** through `Secrets`. The MCP bearer token uses the existing id `SecretIds.mcpBearer = "osmm-mcp-bearer"`. It is never written to `data.json`, `localStorage`, vault files, `_log.md`, Notices, error messages, tool results or the console. The settings show it masked (`••••`); only the **Copy setup command** button puts it on the clipboard. Every tool result passes through `Secrets.redact(…, allSecretIds(channels))`.
- **Desktop only (spec §6.1):** the server starts only when `Platform.isDesktopApp`. `node:http` is loaded with `await import("node:http")` inside `McpService`, never at module top level; `manifest.json` keeps `"isDesktopOnly": false` and the plugin still loads on iOS and Android. `Buffer` is only used inside functions of `src/mcp/server.ts`.
- **Off by default.** Device-local settings (`localStorage "osmm-device"`): `mcp: { enabled: false, port: 27150 }`, port 1024–65535. The token is per device (spec §2.6: each device is set up on its own).
- **Server security (all before parsing the body):** bind `127.0.0.1` only; remote address must be loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) → else 403; `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` → else 403 (DNS rebinding); any `Origin` header → 403 (browsers); `Authorization: Bearer <token>` compared in constant time → else 401 with `WWW-Authenticate: Bearer realm="osmm"`; only `POST /mcp` (other methods 405) and `GET /health` (token required); `Content-Type: application/json` → else 415; body ≤ 1 MiB (`MAX_BODY_BYTES`) → else 413; at most 8 requests in flight → 503; request timeout 30 s; tool results ≤ 200,000 characters.
- **MCP protocol:** the initialize-based revisions `2025-11-25`, `2025-06-18`, `2025-03-26` over Streamable HTTP, JSON responses only (no SSE, no `Mcp-Session-Id`, GET → 405, batches → 400). A request whose `MCP-Protocol-Version` header names another version (e.g. `2026-07-28`) gets `400` with an empty body, so a dual-era client falls back to `initialize`. **No new runtime dependency:** JSON Schemas come from `z.toJSONSchema(schema, { io: "input" })` (zod 4.6, already a dependency).
- **Writes through the model:** every MCP write goes through `NoteFactory`, `PlannerActions.write` (fresh frontmatter, per-key delivery patch) or `SafeWriter` (`setFields`, `editBody`). Results carry structured `issues: { level, field, message, code? }[]`. On a blocking issue nothing is written unless `force_draft: true`, and `force_draft` never applies to a post with pending deliveries. Each MCP write shows a Notice "Claude …" with an **Open** button.
- **Publishing from Claude:** `publish_now` and `push_update` ask in an Obsidian modal by default ("Claude wants to publish …" — what, where, when, Approve / Deny); no answer within `APPROVAL_TIMEOUT_MS = 120_000` means deny; one question at a time; plugin unload answers deny. The synced setting `publishWithoutAsking: string[]` (settings schema 4) lists channels that skip the question. After approval the post is sent only if its content still matches what was shown.
- **Skill rules:** never publish without the user's explicit request in the conversation; with Obsidian closed, write notes directly in the documented format with `status: ready`, `review: claude`, no `deliveries` and never `status: scheduled`; the plugin holds such notes from dispatch and reminders until the user approves them.
- Claude Code plugin: marketplace at `.claude-plugin/marketplace.json` (repo root), plugin in `claude-plugin/` (manifest `claude-plugin/.claude-plugin/plugin.json`, name `osmm`), skill `claude-plugin/skills/social/SKILL.md` (invoked as `/osmm:social`). The plugin version always equals `manifest.json`'s.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A web page in the user's browser tries to talk to the server** (DNS rebinding, a `fetch` in `no-cors` mode, an HTML form posting `text/plain` to `127.0.0.1:27150`). Every such request must be refused before any tool runs: Origin → 403, foreign Host → 403, no token → 401, non-JSON content type → 415. Tests in Task 2.
2. **Claude retries a write after a timeout, or sends it twice at once.** `create_campaign` / `create_variant` with the same `idempotency_key` must return the first note, never create a second; a repeated `schedule` must leave the note as it was. Tests in Tasks 5 and 6.
3. **The post changes between the approval question and the send** (the user edits it in the editor while the modal is open, or Claude calls `update_variant`), **nobody answers**, or **two publish requests arrive together.** Nothing is sent unless the approved content is still the content; a timeout or a second request is a denial with a reason Claude can relay. Tests in Task 8.
4. **Obsidian reloads or the plugin is disabled while the server runs or an approval is open.** The port is released (the next start on the same port works), a pending approval resolves as denied, and an old token stops working at once after "New token". Tests in Tasks 2, 3, 8 and 9.
5. **Notes written by the skill while Obsidian was closed are wrong** (status `scheduled` anyway, a typo'd status, a past time, an unknown channel, text too long). They are never posted or reminded about until the user approves them, and the sidebar shows why they can't be approved. Tests in Task 10.

## Decisions made while writing this plan (spec gaps)

- **Hand-rolled MCP server instead of `@modelcontextprotocol/sdk`.** Issue #73 says "the official MCP TypeScript SDK"; this plan departs from it and asks the owner to confirm. Checked on 2026-09-28: `@modelcontextprotocol/sdk@1.30.1` bundles with esbuild for Obsidian (CJS, Node built-ins external), but a minimal `McpServer` + `StreamableHTTPServerTransport` bundle is about 765 KB minified (zod v3 compatibility layer, ajv with runtime code generation via `new Function`, `@hono/node-server`, zod-to-json-schema), against a whole plugin of about 760 KB today, loaded on phones too. The SDK's `LATEST_PROTOCOL_VERSION` is `2025-11-25`, so it gives no protocol advantage over what we need: four JSON-RPC methods (`initialize`, `ping`, `tools/list`, `tools/call`) with JSON responses. Owning the HTTP layer also lets every security check run before the body is read. There is therefore no dependency to pin; the plan pins the protocol versions instead (`PROTOCOL_VERSIONS`). If the owner prefers the SDK, pin `"@modelcontextprotocol/sdk": "1.30.1"` exactly and keep `server.ts`'s checks in front of its transport. ADR `docs/adr/0002-mcp-server.md` (Task 2) records this.
- **Protocol era.** MCP `2026-07-28` removed `initialize` and sessions. Clients that speak both eras try the modern form first and fall back on a 4xx without a modern error body, so the server answers an unknown `MCP-Protocol-Version` with `400` and an empty body. **(QA)** Check with the installed Claude Code (`claude --debug`) which era it uses; if it is modern-only, add `server/discover` and per-request `_meta` in a follow-up.
- **The Claude Code plugin does not declare the MCP server.** The connection is made with the copied `claude mcp add …` command (spec §6.1, #78); the token lives in Claude Code's own config. Declaring it in `plugin.json` with a `userConfig` token was considered, but it would register a second server beside the copied command and needs a re-entry on every token change.
- **`generate_image` is deferred to M6.** Spec §6.1 lists it, but the `images` module (spec §6.3) is an M6 deliverable; no stub tool is registered.
- **`publish_now` in M4 mostly opens the assisted flow.** No API adapter exists before M5, so after approval the tool opens the assisted flow in Obsidian for assisted channels (the user posts and pastes the link) and runs API channels only on the publisher device. The approval modal still guards both.
- **`push_update`** calls `adapter.update()` for channels that are `published` or `handed_over` with a `remote_id`. No M4 adapter has `update`, so today it refuses without asking; the path is tested with a fake adapter. A new log result `updated` is added to `_log.md`.
- **`schedule` rules.** A time in the past is refused (not "schedule anyway" as in the composer); a post with a handed-over channel is refused (change it in Obsidian); channels awaiting the user need `move_awaiting: true`, which the skill passes only after asking the user (M2b P2).
- **`force_draft`** saves content that has blocking issues. It is refused for a post with pending deliveries (scheduled, awaiting you, handed over, overdue): such a post must be unscheduled first.
- **Idempotency keys** are kept in memory for 24 hours (at most 500); a replay returns the first result with `replayed: true`, and a key whose note was deleted runs again. A plugin reload forgets them.
- **Claude's writes show a Notice with Open, not Undo.** Body edits can't be undone by the plugin's field-level undo; the file history covers them. Approving a Claude draft from the sidebar is a normal UI write with Undo.
- **Offline notes** carry `review: claude` (new optional variant field). Any held note is skipped by `dueItems` and `reminderSlots` (so no dispatch, overdue marking, desktop reminder or ntfy booking) until **Approve & schedule** in the sidebar, or an MCP `schedule`, clears it. **Keep as draft** clears it and unschedules.
- **Fork fix.** `NoteFactory.forkVariant` now refuses to fork a channel whose delivery entry is unreadable (the fork would drop the frozen raw entry, then the channel could be posted again). This also fixes the UI's "Fork for this page".
- **Voice profile tools.** Claude Code may run outside the vault, so the MCP server also offers `get_voice_profile`, `add_voice_refinement` (append-only, dated) and `append_to_campaign` (append-only section, used for review decisions, #85). Nothing overwrites a user note.
- **"Plan with Claude" and "Trim with Claude" buttons** (spec §3 views 1 and 5) are not in the M4 issues and are left out; `ComposerActions.cardActions` stays empty.
- **Default port 27150** (Obsidian Local REST API uses 27123/27124). The approval timeout (2 minutes) stays below Claude Code's 5-minute idle timeout for HTTP servers.

---

## File Structure

```
src/mcp/tools.ts                 ToolRegistry, defineTool, ok, fail, ToolOutcome, ToolResult, MAX_RESULT_CHARS, TOO_LARGE
src/mcp/protocol.ts              McpDispatcher, PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, RPC_ERRORS, rpcError, SERVER_INSTRUCTIONS
src/mcp/server.ts                McpHttpServer, isLoopback, hostAllowed, tokenMatches, MCP_PATH, HEALTH_PATH, MAX_BODY_BYTES, MAX_CONCURRENT
src/mcp/service.ts               McpService, McpStatus, McpActivity, setupCommand, maskedSetupCommand, TOKEN_LENGTH
src/mcp/deps.ts                  McpToolDeps
src/mcp/common.ts                zPath, zWhen, zHttpUrl, zKey, zChannelsArg, normalizePathArg, findPost, noPost, clip, untilIndexed, claudeNotice
src/mcp/present.ts               iso, channelInfo, channelRows, postSummary, campaignInfo, platformRules
src/mcp/idempotency.ts           IdempotencyCache
src/mcp/slots.ts                 findFreeSlots, busyTimes, DEFAULT_WINDOW, MAX_RANGE_DAYS
src/mcp/approval.ts              ApprovalGate, ApprovalRequest, ApprovalAnswer, APPROVAL_TIMEOUT_MS
src/mcp/ApprovalModal.ts         openApprovalModal
src/mcp/index.ts                 registerAllTools
src/mcp/tools/read.ts            list_channels, list_campaigns, get_campaign, list_posts, get_post, get_platform_rules, get_log
src/mcp/tools/write.ts           create_campaign, create_variant, update_variant, fork_variant, validate
src/mcp/tools/schedule.ts        schedule, unschedule
src/mcp/tools/slots.ts           find_free_slots
src/mcp/tools/publish.ts         publish_now, push_update
src/mcp/tools/voice.ts           get_voice_profile, add_voice_refinement, append_to_campaign
src/claude/voice.ts              VOICE_TEMPLATE, voicePath, createVoiceProfile
src/views/McpStatusLight.svelte  sidebar status light
src/views/ClaudeDrafts.svelte    "Written by Claude" sidebar section
docs/adr/0002-mcp-server.md
.claude-plugin/marketplace.json
claude-plugin/.claude-plugin/plugin.json
claude-plugin/README.md
claude-plugin/skills/social/SKILL.md
claude-plugin/skills/social/references/{tools.md,file-format.md,voice.md,review-page.md}
claude-plugin/skills/social/references/platforms/<platform>.md   (13 files)
docs/qa/m4.md
test/mcp/{helpers.ts,protocol.test.ts,server.test.ts,service.test.ts,read.test.ts,write.test.ts,schedule.test.ts,slots.test.ts,publish.test.ts,approval.test.ts,voice.test.ts}
test/claude/{package.test.ts,references.test.ts,playbooks.test.ts}
test/views/claudeSidebar.test.ts
```

Modified: `src/main.ts`, `src/commands.ts`, `src/settings/device.ts` (`mcp`), `src/settings/settings.ts` (schema 4, `publishWithoutAsking`), `src/settings/tab.ts` (Claude Code section), `src/ui/context.ts` (`mcp?`), `src/views/Sidebar.svelte`, `src/styles/planner.css`, `src/model/types.ts` (`review`), `src/model/frontmatter.ts` (`review`), `src/model/writer.ts` (`editBody`), `src/model/factory.ts` (`brief`, fork guard), `src/composer/channels.ts` (`planSetChannels`), `src/composer/actions.ts` (`reviewIssues`, `approveClaudeDraft`, `keepClaudeDraft`), `src/index/queries.ts` (`heldForReview`), `src/scheduler/due.ts`, `src/reminders/reminders.ts`, `src/publish/actions.ts` (`prepareSend`, `sendApproved`, `prepareUpdate`, `updateApproved`, `sendDigest`), `src/publish/log.ts` + `src/publish/vaultLog.ts` (`updated`), `scripts/version-bump.mjs`, `package.json` (`version` script), `test/ui/ctx.ts` (`factory`, device `mcp`), `test/main.test.ts`, `test/settings/settings.test.ts`, `test/model/{writer,factory,frontmatter}.test.ts`, `test/composer/channels.test.ts`, `test/scheduler/scheduler.test.ts` or `test/reminders/reminders.test.ts`, `README.md`, `docs/getting-started.md`.

---
### Task 1: Tool registry and the JSON-RPC dispatcher (#73, part 1)

**Files:**
- Create: `src/mcp/tools.ts`, `src/mcp/protocol.ts`, `test/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: `zodIssues(error, prefix?)` and `Issue` (`src/model/schemas.ts`, `src/model/types.ts`).
- Produces:
  - `type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; issues?: Issue[]; data?: Record<string, unknown> }`; `ok(data?)`, `fail(error, issues?, data?)`.
  - `interface ToolDef<S extends z.ZodType> { name; title; description; input: S; annotations: ToolAnnotations; run(args: z.output<S>): Promise<ToolOutcome> }`; `defineTool(def): ToolDef`.
  - `interface ToolResult { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; isError?: true }`.
  - `class ToolRegistry { constructor({ redact(text): string; onCall?(name, ok): void }); add(def); has(name); names(): string[]; list(): ToolListing[]; call(name, args): Promise<ToolResult> }` — results are `{ ok: true, ...data }` or `{ ok: false, error, issues?, ...data }`, redacted, capped at `MAX_RESULT_CHARS = 200_000`.
  - `class McpDispatcher { constructor({ tools, version, instructions? }); handle(message: unknown): Promise<RpcResponse | null> }` (null for notifications); `PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]`; `LATEST_PROTOCOL_VERSION`; `isSupportedVersion(v)`; `RPC_ERRORS`; `rpcError(id, code, message)`; `SERVER_INSTRUCTIONS`.

- [ ] **Step 1: Write the failing tests**

`test/mcp/protocol.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LATEST_PROTOCOL_VERSION, McpDispatcher, RPC_ERRORS } from "../../src/mcp/protocol";
import { defineTool, fail, MAX_RESULT_CHARS, ok, TOO_LARGE, ToolRegistry } from "../../src/mcp/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;

function build(redact = (t: string) => t) {
  const calls: Array<[string, boolean]> = [];
  const tools = new ToolRegistry({ redact, onCall: (name, good) => void calls.push([name, good]) });
  tools.add(
    defineTool({
      name: "echo",
      title: "Echo",
      description: "Returns its input.",
      input: z.object({ text: z.string().max(10).describe("Text to echo") }).strict(),
      annotations: { readOnlyHint: true },
      run: async ({ text }) => ok({ text }),
    }),
  );
  tools.add(
    defineTool({
      name: "boom",
      title: "Boom",
      description: "Throws.",
      input: z.object({}).strict(),
      annotations: {},
      run: async () => {
        throw new Error("disk on fire");
      },
    }),
  );
  tools.add(
    defineTool({
      name: "refuse",
      title: "Refuse",
      description: "Refuses.",
      input: z.object({}).strict(),
      annotations: {},
      run: async () => fail("No.", [{ level: "error", field: "body", code: "too-long", message: "Too long" }], { hint: "shorter" }),
    }),
  );
  tools.add(
    defineTool({
      name: "huge",
      title: "Huge",
      description: "Too big.",
      input: z.object({}).strict(),
      annotations: {},
      run: async () => ok({ blob: "x".repeat(MAX_RESULT_CHARS) }),
    }),
  );
  const rpc = new McpDispatcher({ tools, version: "0.4.0" });
  const req = async (method: string, params?: unknown, id: number | string = 1): Promise<R> =>
    rpc.handle({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  return { rpc, tools, req, calls };
}

describe("McpDispatcher", () => {
  it("answers initialize with the client's version when supported, otherwise with the latest", async () => {
    const { req } = build();
    const r = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo).toMatchObject({ name: "osmm", version: "0.4.0" });
    expect(r.result.instructions).toContain("publish_now");
    expect((await req("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("answers ping, ignores notifications and rejects what is not JSON-RPC", async () => {
    const { rpc, req } = build();
    expect((await req("ping")).result).toEqual({});
    expect(await rpc.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await rpc.handle({ foo: 1 })).toMatchObject({ id: null, error: { code: RPC_ERRORS.invalidRequest } });
    expect(await rpc.handle({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" })).toMatchObject({ id: null, error: { code: RPC_ERRORS.invalidRequest } });
    expect(await req("resources/list")).toMatchObject({ error: { code: RPC_ERRORS.methodNotFound } });
  });

  it("lists tools with a JSON Schema per input and the annotations", async () => {
    const { req } = build();
    const { tools } = (await req("tools/list")).result;
    expect(tools.map((t: R) => t.name)).toEqual(["echo", "boom", "refuse", "huge"]);
    expect(tools[0]).toEqual({
      name: "echo",
      title: "Echo",
      description: "Returns its input.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 10, description: "Text to echo" } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { title: "Echo", readOnlyHint: true },
    });
  });

  it("calls a tool and returns the result as text and as structured content", async () => {
    const { req, calls } = build();
    const r = await req("tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(r.result.structuredContent).toEqual({ ok: true, text: "hi" });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ ok: true, text: "hi" });
    expect(r.result.isError).toBeUndefined();
    expect(calls).toEqual([["echo", true]]);
  });

  it("returns invalid arguments as a tool error with the field, so Claude can correct itself", async () => {
    const { req, calls } = build();
    const r = await req("tools/call", { name: "echo", arguments: { text: "far too long text", extra: 1 } });
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent.ok).toBe(false);
    expect(r.result.structuredContent.issues.map((i: R) => i.field)).toEqual(expect.arrayContaining(["text"]));
    expect(calls).toEqual([["echo", false]]);
  });

  it("reports an unknown tool as a protocol error and a throwing tool as a tool error", async () => {
    const { req } = build();
    expect(await req("tools/call", { name: "nope", arguments: {} })).toMatchObject({ error: { code: RPC_ERRORS.invalidParams, message: "Unknown tool: nope" } });
    const r = await req("tools/call", { name: "boom" });
    expect(r.result).toMatchObject({ isError: true, structuredContent: { ok: false, error: "disk on fire" } });
  });

  it("passes refusals through with their issues and extra data", async () => {
    const { req } = build();
    const r = await req("tools/call", { name: "refuse" });
    expect(r.result.structuredContent).toEqual({ ok: false, error: "No.", issues: [{ level: "error", field: "body", code: "too-long", message: "Too long" }], hint: "shorter" });
  });

  it("redacts every result and refuses results that are too large", async () => {
    const { req } = build((t) => t.split("SECRET").join("•••"));
    expect((await req("tools/call", { name: "echo", arguments: { text: "SECRET" } })).result.structuredContent.text).toBe("•••");
    const big = await req("tools/call", { name: "huge" });
    expect(big.result).toMatchObject({ isError: true, structuredContent: { ok: false, error: TOO_LARGE } });
  });

  it("refuses to register two tools with the same name or a bad name", () => {
    const { tools } = build();
    const def = defineTool({ name: "echo", title: "x", description: "x", input: z.object({}), annotations: {}, run: async () => ok() });
    expect(() => tools.add(def)).toThrow(/twice/);
    expect(() => tools.add({ ...def, name: "Bad-Name" })).toThrow(/Invalid tool name/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/protocol.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/protocol'`.

- [ ] **Step 3: Write the registry**

`src/mcp/tools.ts`:
```ts
import { z } from "zod";
import { zodIssues } from "../model/schemas";
import type { Issue } from "../model/types";

/** MCP tool annotations: hints for the client, never trusted for security. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; issues?: Issue[]; data?: Record<string, unknown> };

export const ok = (data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, data });

export const fail = (error: string, issues?: readonly Issue[], data?: Record<string, unknown>): ToolOutcome => ({
  ok: false,
  error,
  ...(issues?.length ? { issues: [...issues] } : {}),
  ...(data ? { data } : {}),
});

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** snake_case, as Claude sees it. */
  name: string;
  title: string;
  /** Written for the model: what it does, when to use it, what it never does. */
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(args: z.output<S>): Promise<ToolOutcome>;
}

/** Keeps each tool's argument type while storing them together. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
}

export interface ToolListing {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations & { title: string };
}

export const MAX_RESULT_CHARS = 200_000;
export const TOO_LARGE = "The result is too large. Narrow the request (a smaller limit, a date range or one campaign).";
const UNSHAREABLE = "The result could not be shared safely.";
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface RegistryOptions {
  /** Removes every known secret value from the result text (Secrets.redact over allSecretIds). */
  redact(text: string): string;
  /** Last-activity display in the settings (#78). */
  onCall?(name: string, ok: boolean): void;
}

export class UnknownToolError extends Error {
  constructor(readonly tool: string) {
    super(`Unknown tool: ${tool}`);
    this.name = "UnknownToolError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(private readonly opts: RegistryOptions) {}

  add(def: ToolDef): void {
    if (!NAME_RE.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
    if (this.tools.has(def.name)) throw new Error(`Tool "${def.name}" is registered twice`);
    this.tools.set(def.name, def);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): ToolListing[] {
    return [...this.tools.values()].map((t) => {
      const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
      delete schema.$schema;
      return { name: t.name, title: t.title, description: t.description, inputSchema: schema, annotations: { title: t.title, ...t.annotations } };
    });
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    const parsed = tool.input.safeParse(args ?? {});
    let outcome: ToolOutcome;
    if (!parsed.success) {
      outcome = fail("Invalid arguments. Fix them and call the tool again.", zodIssues(parsed.error));
    } else {
      try {
        outcome = await tool.run(parsed.data);
      } catch (e) {
        outcome = fail(e instanceof Error ? e.message : String(e));
      }
    }
    this.opts.onCall?.(name, outcome.ok);
    return this.result(outcome);
  }

  private result(outcome: ToolOutcome): ToolResult {
    const body = outcome.ok
      ? { ok: true, ...outcome.data }
      : { ok: false, error: outcome.error, ...(outcome.issues ? { issues: outcome.issues } : {}), ...outcome.data };
    let text = this.opts.redact(JSON.stringify(body));
    let isError = !outcome.ok;
    if (text.length > MAX_RESULT_CHARS) {
      text = JSON.stringify({ ok: false, error: TOO_LARGE });
      isError = true;
    }
    let structured: Record<string, unknown>;
    try {
      structured = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Redaction cut through an escape sequence: never send a half-redacted value.
      text = JSON.stringify({ ok: false, error: UNSHAREABLE });
      structured = { ok: false, error: UNSHAREABLE };
      isError = true;
    }
    return { content: [{ type: "text", text }], structuredContent: structured, ...(isError ? { isError: true as const } : {}) };
  }
}
```

- [ ] **Step 4: Write the dispatcher**

`src/mcp/protocol.ts`:
```ts
import type { ToolRegistry } from "./tools";

/** Initialize-based MCP revisions this server speaks (see ADR 0002). Newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION: string = PROTOCOL_VERSIONS[0];

export const RPC_ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export type RpcId = string | number | null;
export interface RpcError {
  code: number;
  message: string;
}
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: RpcError };

export const SERVER_INSTRUCTIONS =
  "Social Planner (OSMM) for Obsidian: plans, drafts, validates and schedules social posts stored as notes in the user's vault. " +
  "Read before you write (list_channels, list_campaigns, get_campaign, get_post, get_platform_rules). " +
  "Every write validates the post and returns structured issues; nothing is written when an issue blocks, unless you pass force_draft. " +
  "Times are ISO 8601 with an offset, e.g. 2026-10-08T17:30:00+02:00. find_free_slots proposes times. " +
  "schedule makes a post go out at its time. publish_now and push_update ask the user in Obsidian first; call them only when the user asked you to publish right now.";

export function isSupportedVersion(v: unknown): v is string {
  return typeof v === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

export function rpcError(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(id: unknown): id is string | number {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

export interface DispatcherDeps {
  tools: ToolRegistry;
  /** The Obsidian plugin version (manifest.json). */
  version: string;
  instructions?: string;
}

/** JSON-RPC 2.0 for MCP: initialize, ping, tools/list, tools/call. Stateless: no session is kept. */
export class McpDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  async handle(message: unknown): Promise<RpcResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request.");
    }
    // A notification (notifications/initialized, notifications/cancelled, …): nothing to answer.
    if (!("id" in message)) return null;
    if (!validId(message.id)) return rpcError(null, RPC_ERRORS.invalidRequest, "Invalid request id.");
    const id = message.id;
    const params = isRecord(message.params) ? message.params : {};
    try {
      switch (message.method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: this.initialize(params) };
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: this.deps.tools.list() } };
        case "tools/call": {
          const name = params.name;
          if (typeof name !== "string") return rpcError(id, RPC_ERRORS.invalidParams, "tools/call needs a tool name.");
          if (!this.deps.tools.has(name)) return rpcError(id, RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
          return { jsonrpc: "2.0", id, result: await this.deps.tools.call(name, params.arguments) };
        }
        default:
          return rpcError(id, RPC_ERRORS.methodNotFound, `Method not found: ${message.method}`);
      }
    } catch {
      return rpcError(id, RPC_ERRORS.internal, "Internal error.");
    }
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = params.protocolVersion;
    return {
      protocolVersion: isSupportedVersion(requested) ? requested : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "osmm", title: "Social Planner (OSMM)", version: this.deps.version },
      instructions: this.deps.instructions ?? SERVER_INSTRUCTIONS,
    };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/protocol.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/mcp/protocol.ts test/mcp/protocol.test.ts
git commit -m "feat(mcp): tool registry with validated arguments and a JSON-RPC dispatcher (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Local HTTP server with token, Host, Origin and size checks (#73, part 2)

**Files:**
- Create: `src/mcp/server.ts`, `test/mcp/server.test.ts`, `docs/adr/0002-mcp-server.md`

**Interfaces:**
- Consumes: `isSupportedVersion`, `rpcError`, `RPC_ERRORS` (Task 1).
- Produces:
  - `class McpHttpServer { constructor(deps: McpServerDeps); readonly port: number | null; start(port: number): Promise<number>; stop(): Promise<void> }` where `McpServerDeps = { createServer: typeof import("node:http").createServer; token(): string | null; handle(message: unknown): Promise<unknown | null>; version: string; now(): number; onRequest?(info: RequestInfo): void }` and `RequestInfo = { at: number; status: number; path: string; method: string }`.
  - `isLoopback(address)`, `hostAllowed(host, port)`, `tokenMatches(expected, header)`; constants `MCP_PATH = "/mcp"`, `HEALTH_PATH = "/health"`, `MAX_BODY_BYTES = 1_048_576`, `MAX_CONCURRENT = 8`, `REQUEST_TIMEOUT_MS = 30_000`.
  - `start()` rejects with `Error("Port <n> is already in use. Pick another port in Settings → Social Planner → Claude Code.")` on `EADDRINUSE`; `stop()` closes every open connection so a reload never keeps the port.

- [ ] **Step 1: Write the failing tests**

`test/mcp/server.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { hostAllowed, isLoopback, MAX_BODY_BYTES, McpHttpServer, tokenMatches, type RequestInfo } from "../../src/mcp/server";

const TOKEN = "T".repeat(43);
const servers: McpHttpServer[] = [];
const blockers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const b of blockers.splice(0)) await new Promise((r) => b.close(r));
});

interface Sent {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/mcp", headers: { Host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

async function build(opts: { handle?: (m: unknown) => Promise<unknown | null>; token?: string | null } = {}) {
  const requests: RequestInfo[] = [];
  const server = new McpHttpServer({
    createServer: http.createServer,
    token: () => (opts.token === undefined ? TOKEN : opts.token),
    handle: opts.handle ?? (async (m) => ({ jsonrpc: "2.0", id: (m as { id?: number }).id ?? null, result: { echoed: m } })),
    version: "0.4.0",
    now: () => 1_000,
    onRequest: (info) => void requests.push(info),
  });
  const port = await server.start(0);
  servers.push(server);
  return { server, port, requests };
}

describe("McpHttpServer", () => {
  it("answers an authorised JSON-RPC POST on 127.0.0.1", async () => {
    const { port, requests } = await build();
    const r = await send(port, { headers: auth, body: ping });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toMatchObject({ id: 1, result: { echoed: { method: "ping" } } });
    expect(requests).toEqual([{ at: 1_000, status: 200, path: "/mcp", method: "POST" }]);
  });

  it("accepts a notification with 202 and no body", async () => {
    const { port } = await build({ handle: async () => null });
    const r = await send(port, { headers: auth, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect([r.status, r.body]).toEqual([202, ""]);
  });

  it("requires the bearer token (#73)", async () => {
    const { port } = await build();
    const none = await send(port, { headers: { "Content-Type": "application/json" }, body: ping });
    expect(none.status).toBe(401);
    expect(none.headers["www-authenticate"]).toBe('Bearer realm="osmm"');
    expect((await send(port, { headers: { ...auth, Authorization: `Bearer ${"X".repeat(43)}` }, body: ping })).status).toBe(401);
    expect((await send(port, { headers: { ...auth, Authorization: `bearer ${TOKEN}` }, body: ping })).status).toBe(200);
  });

  it("answers 503 while no token exists yet", async () => {
    const { port } = await build({ token: null });
    expect((await send(port, { headers: auth, body: ping })).status).toBe(503);
  });

  it("refuses browser requests and foreign Host headers before anything else (review focus 1)", async () => {
    const calls: unknown[] = [];
    const { port } = await build({ handle: async (m) => (calls.push(m), { jsonrpc: "2.0", id: 1, result: {} }) });
    expect((await send(port, { headers: { ...auth, Origin: "https://evil.example" }, body: ping })).status).toBe(403);
    expect((await send(port, { headers: { ...auth, Origin: `http://127.0.0.1:${port}` }, body: ping })).status).toBe(403);
    expect((await send(port, { headers: { ...auth, Host: `evil.example:${port}` }, body: ping })).status).toBe(403);
    expect((await send(port, { headers: { ...auth, Host: "127.0.0.1:1" }, body: ping })).status).toBe(403);
    expect((await send(port, { headers: { ...auth, "Content-Type": "text/plain" }, body: ping })).status).toBe(415);
    expect(calls).toEqual([]);
    expect((await send(port, { headers: { ...auth, Host: `localhost:${port}` }, body: ping })).status).toBe(200);
  });

  it("serves only POST /mcp and an authenticated GET /health", async () => {
    const { port } = await build();
    const get = await send(port, { method: "GET", headers: auth });
    expect([get.status, get.headers.allow]).toEqual([405, "POST"]);
    expect((await send(port, { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await send(port, { path: "/other", headers: auth, body: ping })).status).toBe(404);
    const health = await send(port, { method: "GET", path: "/health", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect([health.status, JSON.parse(health.body)]).toEqual([200, { ok: true, server: "osmm", version: "0.4.0" }]);
    expect((await send(port, { method: "GET", path: "/health" })).status).toBe(401);
  });

  it("limits the body to 1 MiB, declared or streamed", async () => {
    const { port } = await build();
    // Declared too large: refused from the headers alone, before any byte of the body is read.
    const declared = await send(port, { headers: { ...auth, "Content-Length": String(MAX_BODY_BYTES + 1) }, body: "" });
    expect(declared.status).toBe(413);
    const streamed = await send(port, { headers: auth, body: `{"x":"${"a".repeat(MAX_BODY_BYTES + 10)}"}` });
    expect(streamed.status).toBe(413);
  });

  it("answers parse errors and batches with JSON-RPC errors", async () => {
    const { port } = await build();
    const bad = await send(port, { headers: auth, body: "{not json" });
    expect([bad.status, JSON.parse(bad.body).error.code]).toEqual([400, -32700]);
    const batch = await send(port, { headers: auth, body: JSON.stringify([JSON.parse(ping)]) });
    expect([batch.status, JSON.parse(batch.body).error.code]).toEqual([400, -32600]);
  });

  it("answers an unknown MCP-Protocol-Version with an empty 400 so dual-era clients fall back", async () => {
    const { port } = await build();
    const modern = await send(port, { headers: { ...auth, "MCP-Protocol-Version": "2026-07-28" }, body: ping });
    expect([modern.status, modern.body]).toEqual([400, ""]);
    expect((await send(port, { headers: { ...auth, "MCP-Protocol-Version": "2025-06-18" }, body: ping })).status).toBe(200);
  });

  it("answers 503 beyond 8 requests in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { port } = await build({ handle: async () => (await gate, { jsonrpc: "2.0", id: 1, result: {} }) });
    const pending = Array.from({ length: 8 }, () => send(port, { headers: auth, body: ping }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await send(port, { headers: auth, body: ping })).status).toBe(503);
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it("turns a handler crash into a JSON-RPC internal error", async () => {
    const { port } = await build({
      handle: async () => {
        throw new Error("boom");
      },
    });
    const r = await send(port, { headers: auth, body: ping });
    expect([r.status, JSON.parse(r.body).error.code]).toEqual([500, -32603]);
  });

  it("releases the port on stop, so a reload can bind it again (#73 acceptance, review focus 4)", async () => {
    const { server, port } = await build();
    await server.stop();
    await expect(send(port, { headers: auth, body: ping })).rejects.toThrow(/ECONNREFUSED/);
    const again = await build();
    const second = again.server;
    await second.stop();
    expect(await second.start(port)).toBe(port);
    expect((await send(port, { headers: auth, body: ping })).status).toBe(200);
  });

  it("explains a port that is already in use", async () => {
    const blocker = http.createServer();
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const server = new McpHttpServer({ createServer: http.createServer, token: () => TOKEN, handle: async () => null, version: "0", now: () => 0 });
    await expect(server.start(port)).rejects.toThrow(`Port ${port} is already in use`);
    expect(server.port).toBeNull();
  });
});

describe("request checks", () => {
  it("accepts only loopback peers", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"].every(isLoopback)).toBe(true);
    expect([undefined, "192.168.1.10", "::ffff:10.0.0.2", "0.0.0.0"].some(isLoopback)).toBe(false);
  });

  it("accepts only the loopback host names on this port", () => {
    expect(hostAllowed("127.0.0.1:27150", 27150)).toBe(true);
    expect(hostAllowed("LOCALHOST:27150", 27150)).toBe(true);
    expect(hostAllowed("[::1]:27150", 27150)).toBe(true);
    expect(hostAllowed("127.0.0.1", 27150)).toBe(false);
    expect(hostAllowed("attacker.example:27150", 27150)).toBe(false);
    expect(hostAllowed(undefined, 27150)).toBe(false);
  });

  it("compares the token exactly", () => {
    expect(tokenMatches("abc123", "Bearer abc123")).toBe(true);
    expect(tokenMatches("abc123", "Bearer abc1234")).toBe(false);
    expect(tokenMatches("abc123", "Bearer abc12")).toBe(false);
    expect(tokenMatches("abc123", "Basic abc123")).toBe(false);
    expect(tokenMatches(null, "Bearer abc123")).toBe(false);
    expect(tokenMatches("abc123", undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/server.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/server'`.

- [ ] **Step 3: Write the server**

`src/mcp/server.ts`:
```ts
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isSupportedVersion, RPC_ERRORS, rpcError } from "./protocol";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT = 8;
export const REQUEST_TIMEOUT_MS = 30_000;

type CreateServer = typeof import("node:http").createServer;

export interface RequestInfo {
  at: number;
  status: number;
  path: string;
  method: string;
}

export interface McpServerDeps {
  /** Node's http.createServer; injected so the module never loads Node code on phones. */
  createServer: CreateServer;
  /** Read on every request: a new token takes effect at once. */
  token(): string | null;
  handle(message: unknown): Promise<unknown | null>;
  version: string;
  now(): number;
  onRequest?(info: RequestInfo): void;
}

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** DNS rebinding guard: a page on evil.example resolving to 127.0.0.1 still sends `Host: evil.example:<port>`. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** Constant-time comparison of `Bearer <token>` with the expected token. */
export function tokenMatches(expected: string | null, header: string | undefined): boolean {
  if (!expected || typeof header !== "string") return false;
  const given = /^bearer\s+(\S+)$/i.exec(header.trim())?.[1] ?? "";
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

function pathOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0] ?? "/";
}

/** Reads the body up to `limit` bytes; null when it is larger (the rest is drained and dropped). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * MCP Streamable HTTP (JSON responses only) on 127.0.0.1 (spec §6.1). Every security check runs before the
 * body is read: loopback peer, Host, no Origin, token, path, method, content type, protocol version, size.
 */
export class McpHttpServer {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private active = 0;

  constructor(private readonly deps: McpServerDeps) {}

  get port(): number | null {
    return this.boundPort;
  }

  async start(port: number): Promise<number> {
    await this.stop();
    const server = this.deps.createServer((req, res) => void this.route(req, res));
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use. Pick another port in Settings → Social Planner → Claude Code.`) : e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    // After listening, errors belong to single connections; they must not crash Obsidian.
    server.on("error", () => undefined);
    const address = server.address();
    this.server = server;
    this.boundPort = typeof address === "object" && address ? address.port : port;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private finish(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(payload ? { "Content-Type": "application/json" } : {}),
      ...headers,
    });
    res.end(payload);
    this.deps.onRequest?.({ at: this.deps.now(), status, path: pathOf(req.url), method: req.method ?? "" });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch {
      if (!res.headersSent) this.finish(req, res, 500, rpcError(null, RPC_ERRORS.internal, "Internal error."));
      else res.destroy();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.boundPort ?? 0;
    if (!isLoopback(req.socket.remoteAddress)) return this.finish(req, res, 403, { error: "Only connections from this computer are accepted." });
    if (!hostAllowed(req.headers.host, port)) return this.finish(req, res, 403, { error: "Invalid Host header." });
    if (req.headers.origin !== undefined) return this.finish(req, res, 403, { error: "Requests from web pages are not accepted." });
    const path = pathOf(req.url);
    if (path !== MCP_PATH && path !== HEALTH_PATH) return this.finish(req, res, 404, { error: "Not found." });
    const token = this.deps.token();
    if (!token) return this.finish(req, res, 503, { error: "The server has no access token yet." });
    if (!tokenMatches(token, req.headers.authorization)) {
      return this.finish(req, res, 401, { error: "Missing or wrong access token." }, { "WWW-Authenticate": 'Bearer realm="osmm"' });
    }
    if (path === HEALTH_PATH) {
      if (req.method !== "GET") return this.finish(req, res, 405, undefined, { Allow: "GET" });
      return this.finish(req, res, 200, { ok: true, server: "osmm", version: this.deps.version });
    }
    if (req.method !== "POST") return this.finish(req, res, 405, undefined, { Allow: "POST" });
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return this.finish(req, res, 415, { error: "Use Content-Type: application/json." });
    const version = req.headers["mcp-protocol-version"];
    // Empty body on purpose: a client that speaks both MCP eras reads it as "legacy server" and sends initialize.
    if (typeof version === "string" && !isSupportedVersion(version)) return this.finish(req, res, 400);
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return this.finish(req, res, 413, { error: "Request too large." }, { Connection: "close" });
    if (this.active >= MAX_CONCURRENT) return this.finish(req, res, 503, { error: "Too many requests at once." }, { "Retry-After": "1" });
    this.active++;
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw === null) return this.finish(req, res, 413, { error: "Request too large." }, { Connection: "close" });
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return this.finish(req, res, 400, rpcError(null, RPC_ERRORS.parse, "Parse error."));
      }
      if (Array.isArray(message)) return this.finish(req, res, 400, rpcError(null, RPC_ERRORS.invalidRequest, "Batches are not supported."));
      const response = await this.deps.handle(message);
      if (response === null) return this.finish(req, res, 202);
      return this.finish(req, res, 200, response);
    } finally {
      this.active--;
    }
  }
}
```

- [ ] **Step 4: Record the decision**

`docs/adr/0002-mcp-server.md`:
```markdown
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/server.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts test/mcp/server.test.ts docs/adr/0002-mcp-server.md
git commit -m "feat(mcp): local Streamable HTTP server with token, Host, Origin and size checks (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Server lifecycle, token and desktop guard (#73, part 3)

**Files:**
- Create: `src/mcp/service.ts`, `test/mcp/net.ts`, `test/mcp/service.test.ts`
- Modify: `src/settings/device.ts`, `src/main.ts`, `test/ui/ctx.ts` (device literal), `test/main.test.ts`

**Interfaces:**
- Consumes: `McpHttpServer`, `HEALTH_PATH`, `MCP_PATH`, `RequestInfo` (Task 2); `McpDispatcher` (Task 1); `ToolRegistry` (Task 1); `randomString` (`src/model/ids.ts`); `SecretIds.mcpBearer`, `allSecretIds`, `Secrets` (`src/secrets/secrets.ts`).
- Produces:
  - `interface McpDeviceSettings { enabled: boolean; port: number }` on `DeviceSettings.mcp`; `DEFAULT_MCP_PORT = 27150`; `parsePort(value: unknown): number | null` (integers 1024–65535).
  - `type McpStatus = { state: "unavailable" } | { state: "off" } | { state: "starting" } | { state: "on"; port: number } | { state: "error"; message: string }`.
  - `interface McpActivity { last: { at: number; label: string } | null; refused: { at: number; status: number } | null }`.
  - `class McpService { status: Writable<McpStatus>; activity: Writable<McpActivity>; token(): string | null; ensureToken(): string; rotateToken(): string; apply(): Promise<void>; dispose(): Promise<void>; record(label: string): void; currentPort(): number | null; setupCommand(): string | null; maskedSetupCommand(): string; testConnection(): Promise<{ ok: true } | { ok: false; message: string }> }`.
  - `setupCommand(port, token)` → `claude mcp add --transport http --scope user --header "Authorization: Bearer <token>" osmm http://127.0.0.1:<port>/mcp`; `TOKEN_LENGTH = 43` (base62, about 256 bits).
  - `OsmmPlugin.tools: ToolRegistry`, `OsmmPlugin.mcp: McpService`. The server starts after the startup check (`onLayoutReady`) when `device.mcp.enabled`, and stops on unload.
  - Test helpers `freePort(): Promise<number>`, `portIsFree(port): Promise<boolean>` in `test/mcp/net.ts`.

- [ ] **Step 1: Write the test helpers and the failing tests**

`test/mcp/net.ts`:
```ts
import * as net from "node:net";

/** A port nothing listens on right now (the OS picks it, then it is released). */
export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** True when a new listener can bind the port (nobody holds it). */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
```

`test/mcp/service.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { get } from "svelte/store";
import { McpService, setupCommand, TOKEN_LENGTH } from "../../src/mcp/service";
import { SecretIds } from "../../src/secrets/secrets";
import type { McpDeviceSettings } from "../../src/settings/device";
import { freePort, portIsFree } from "./net";

const services: McpService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});

function build(opts: { desktop?: boolean; settings?: McpDeviceSettings } = {}) {
  const store = new Map<string, string>();
  let settings: McpDeviceSettings = opts.settings ?? { enabled: false, port: 27150 };
  let loads = 0;
  const service = new McpService({
    desktop: () => opts.desktop ?? true,
    settings: () => settings,
    secrets: { get: (id) => store.get(id) ?? null, set: (id, value) => void store.set(id, value) },
    handle: async (m) => ({ jsonrpc: "2.0", id: (m as { id?: number }).id ?? null, result: {} }),
    version: "0.4.0",
    now: () => 5_000,
    loadHttp: async () => {
      loads++;
      return http;
    },
  });
  services.push(service);
  return { service, store, loads: () => loads, set: (next: McpDeviceSettings) => void (settings = next) };
}

function status(port: number, token: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}

describe("McpService", () => {
  it("is off by default and creates nothing (#73)", async () => {
    const { service, store, loads } = build();
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
    expect(loads()).toBe(0);
    expect(store.size).toBe(0);
  });

  it("never loads Node's http on a phone, even when switched on", async () => {
    const { service, loads } = build({ desktop: false, settings: { enabled: true, port: 27150 } });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "unavailable" });
    expect(loads()).toBe(0);
  });

  it("starts with a new 256-bit token kept in secret storage only", async () => {
    const port = await freePort();
    const { service, store } = build({ settings: { enabled: true, port } });
    await service.apply();
    const token = store.get(SecretIds.mcpBearer)!;
    expect(token).toMatch(new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`));
    expect(get(service.status)).toEqual({ state: "on", port });
    expect(await service.testConnection()).toEqual({ ok: true });
    expect(service.setupCommand()).toBe(setupCommand(port, token));
    expect(service.setupCommand()).toBe(`claude mcp add --transport http --scope user --header "Authorization: Bearer ${token}" osmm http://127.0.0.1:${port}/mcp`);
    expect(service.maskedSetupCommand()).not.toContain(token);
    expect(await status(port, token)).toBe(200);
  });

  it("stops the old token at once after a rotation (review focus 4)", async () => {
    const port = await freePort();
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    const old = service.token()!;
    const next = service.rotateToken();
    expect(next).not.toBe(old);
    expect(await status(port, old)).toBe(401);
    expect(await status(port, next)).toBe(200);
  });

  it("moves to a new port and frees the old one", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const { service, set } = build({ settings: { enabled: true, port: a } });
    await service.apply();
    set({ enabled: true, port: b });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "on", port: b });
    expect(await portIsFree(a)).toBe(true);
  });

  it("reports a port in use and recovers once it is free", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    expect(get(service.status)).toMatchObject({ state: "error", message: expect.stringContaining("already in use") });
    await new Promise((r) => blocker.close(r));
    await service.apply();
    expect(get(service.status)).toEqual({ state: "on", port });
  });

  it("stops when switched off and when disposed, and stays off afterwards (review focus 4)", async () => {
    const port = await freePort();
    const { service, set } = build({ settings: { enabled: true, port } });
    await service.apply();
    set({ enabled: false, port });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
    expect(await portIsFree(port)).toBe(true);
    set({ enabled: true, port });
    await service.apply();
    await service.dispose();
    expect(await portIsFree(port)).toBe(true);
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
  });

  it("starts once when asked twice at the same time", async () => {
    const port = await freePort();
    const { service, loads } = build({ settings: { enabled: true, port } });
    await Promise.all([service.apply(), service.apply()]);
    expect(loads()).toBe(1);
    expect(get(service.status)).toEqual({ state: "on", port });
  });

  it("records the last tool call and the last refused request", async () => {
    const port = await freePort();
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    service.record("create_variant");
    expect(await status(port, null)).toBe(401);
    expect(get(service.activity)).toEqual({ last: { at: 5_000, label: "create_variant" }, refused: { at: 5_000, status: 401 } });
  });

  it("says the server is off when testing a stopped server", async () => {
    const { service } = build();
    expect(await service.testConnection()).toEqual({ ok: false, message: "The server is off." });
  });
});
```

Add to `test/main.test.ts` (new `describe` at the end of the file; add `import { get } from "svelte/store";`, `import { setPlatform } from "./fakes/obsidian";` to the existing fakes import, and `import { freePort, portIsFree } from "./mcp/net";`):
```ts
describe("Claude Code server (#73)", () => {
  it("stays off by default on a desktop", async () => {
    const { plugin } = await loaded();
    expect(plugin.device.mcp).toEqual({ enabled: false, port: 27150 });
    expect(get(plugin.mcp.status)).toEqual({ state: "off" });
    plugin.unload();
  });

  it("is unavailable on phones and the plugin still loads", async () => {
    setPlatform("iphone");
    const { plugin } = await loaded();
    await plugin.mcp.apply();
    expect(get(plugin.mcp.status)).toEqual({ state: "unavailable" });
    plugin.unload();
  });

  it("starts at load when it was on, and releases the port on unload (review focus 4)", async () => {
    const port = await freePort();
    const app = new App();
    app.saveLocalStorage("osmm-device", { mcp: { enabled: true, port } });
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await settle();
    await plugin.mcp.apply();
    expect(get(plugin.mcp.status)).toEqual({ state: "on", port });
    plugin.unload();
    await plugin.mcp.apply();
    expect(await portIsFree(port)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/service.test.ts test/main.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/service'`, and `plugin.device.mcp` is undefined.

- [ ] **Step 3: Add the device settings**

In `src/settings/device.ts`, after `NtfyDeviceSettings`:
```ts
/** The local MCP server for Claude Code on this device (#73, #78). Its token lives in secret storage, never here. */
export interface McpDeviceSettings {
  enabled: boolean;
  port: number;
}

export const DEFAULT_MCP_PORT = 27150;

/** A TCP port the user may pick: an integer from 1024 to 65535 (no privileged ports). */
export function parsePort(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function sanitizeMcp(raw: unknown): McpDeviceSettings {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {};
  return { enabled: r.enabled === true, port: parsePort(r.port) ?? DEFAULT_MCP_PORT };
}
```
Add `mcp: McpDeviceSettings;` to `DeviceSettings` (after `ntfy`), and `mcp: sanitizeMcp(raw.mcp),` to the object returned by `sanitize`.

In `test/ui/ctx.ts`, extend the device literal: `…, ntfy: { enabled: false, server: "https://ntfy.sh", results: false }, mcp: { enabled: false, port: 27150 } };`. Run `grep -rn "ntfy: { enabled" test` and add the same `mcp` field to any other full `DeviceSettings` literal it finds.

- [ ] **Step 4: Write the service**

`src/mcp/service.ts`:
```ts
import { writable, type Writable } from "svelte/store";
import { randomString } from "../model/ids";
import { SecretIds } from "../secrets/secrets";
import type { McpDeviceSettings } from "../settings/device";
import { HEALTH_PATH, MCP_PATH, McpHttpServer, type RequestInfo } from "./server";

export const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 43 base62 characters ≈ 256 bits. */
export const TOKEN_LENGTH = 43;
export const SERVER_NAME = "osmm";

export type McpStatus =
  | { state: "unavailable" }
  | { state: "off" }
  | { state: "starting" }
  | { state: "on"; port: number }
  | { state: "error"; message: string };

export interface McpActivity {
  last: { at: number; label: string } | null;
  refused: { at: number; status: number } | null;
}

type HttpModule = Pick<typeof import("node:http"), "createServer" | "request">;

export interface McpServiceDeps {
  /** Platform.isDesktopApp: the server never runs on phones (spec §6.1). */
  desktop(): boolean;
  settings(): McpDeviceSettings;
  secrets: { get(id: string): string | null; set(id: string, value: string): void };
  handle(message: unknown): Promise<unknown | null>;
  version: string;
  now(): number;
  /** Loads Node's http module; only called on a desktop, when the server starts. */
  loadHttp?(): Promise<HttpModule>;
}

export function setupCommand(port: number, token: string): string {
  return `claude mcp add --transport http --scope user --header "Authorization: Bearer ${token}" ${SERVER_NAME} http://127.0.0.1:${port}${MCP_PATH}`;
}

/** Starts and stops the local MCP server to match this device's settings; owns its token (spec §2.6, §6.1). */
export class McpService {
  readonly status: Writable<McpStatus>;
  readonly activity = writable<McpActivity>({ last: null, refused: null });
  private server: McpHttpServer | null = null;
  private http: HttpModule | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: McpServiceDeps) {
    this.status = writable<McpStatus>(deps.desktop() ? { state: "off" } : { state: "unavailable" });
  }

  token(): string | null {
    return this.deps.secrets.get(SecretIds.mcpBearer);
  }

  ensureToken(): string {
    return this.token() ?? this.rotateToken();
  }

  /** A new token; the server reads it per request, so the old one stops working at once. */
  rotateToken(): string {
    const token = randomString(TOKEN_LENGTH, TOKEN_ALPHABET);
    this.deps.secrets.set(SecretIds.mcpBearer, token);
    return token;
  }

  /** Brings the server in line with the settings. Calls run one after another. */
  apply(): Promise<void> {
    const run = this.queue.then(() => this.sync());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Plugin unload: stop and never start again. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.apply();
  }

  record(label: string): void {
    this.activity.update((a) => ({ ...a, last: { at: this.deps.now(), label } }));
  }

  currentPort(): number | null {
    return this.server?.port ?? null;
  }

  setupCommand(): string | null {
    const token = this.token();
    return token ? setupCommand(this.currentPort() ?? this.deps.settings().port, token) : null;
  }

  /** For the settings: the command with the token hidden. */
  maskedSetupCommand(): string {
    return setupCommand(this.currentPort() ?? this.deps.settings().port, "••••");
  }

  async testConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
    const port = this.currentPort();
    const token = this.token();
    const http = this.http;
    if (port === null || !token || !http) return { ok: false, message: "The server is off." };
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: HEALTH_PATH, method: "GET", headers: { Authorization: `Bearer ${token}` }, timeout: 5_000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200 ? { ok: true } : { ok: false, message: `The server answered ${res.statusCode ?? "nothing"}.` });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, message: "No answer within 5 seconds." });
      });
      req.on("error", (e) => resolve({ ok: false, message: e.message }));
      req.end();
    });
  }

  private async sync(): Promise<void> {
    if (!this.deps.desktop()) {
      this.status.set({ state: "unavailable" });
      return;
    }
    const { enabled, port } = this.deps.settings();
    if (this.disposed || !enabled) {
      await this.server?.stop();
      this.server = null;
      this.status.set({ state: "off" });
      return;
    }
    if (this.server?.port === port) return;
    this.status.set({ state: "starting" });
    try {
      this.ensureToken();
      const http = (this.http ??= await (this.deps.loadHttp ?? (() => import("node:http")))());
      await this.server?.stop();
      this.server ??= new McpHttpServer({
        createServer: http.createServer,
        token: () => this.token(),
        handle: (message) => this.deps.handle(message),
        version: this.deps.version,
        now: () => this.deps.now(),
        onRequest: (info) => this.onRequest(info),
      });
      const bound = await this.server.start(port);
      this.status.set({ state: "on", port: bound });
    } catch (e) {
      await this.server?.stop();
      this.server = null;
      this.status.set({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private onRequest(info: RequestInfo): void {
    if (info.status === 401 || info.status === 403) this.activity.update((a) => ({ ...a, refused: { at: info.at, status: info.status } }));
  }
}
```

- [ ] **Step 5: Wire it into the plugin**

In `src/main.ts`:
- imports: add `Platform` to the `obsidian` import; add
```ts
import { McpDispatcher } from "./mcp/protocol";
import { McpService } from "./mcp/service";
import { ToolRegistry } from "./mcp/tools";
```
- fields (after `log!: VaultLog;`):
```ts
  /** MCP tools for Claude Code (spec §6.1); the server exposes them only on a desktop, when switched on. */
  tools!: ToolRegistry;
  mcp!: McpService;
```
- in `onload()`, right after `this.register(() => this.scheduler.stop());`:
```ts
    this.tools = new ToolRegistry({
      redact: (text) => this.secrets.redact(text, allSecretIds(this.channels.list())),
      onCall: (name, ok) => this.mcp.record(ok ? name : `${name} (refused)`),
    });
    const dispatcher = new McpDispatcher({ tools: this.tools, version: this.manifest.version });
    this.mcp = new McpService({
      desktop: () => Platform.isDesktopApp,
      settings: () => this.device.mcp,
      secrets: this.secrets,
      handle: (message) => dispatcher.handle(message),
      version: this.manifest.version,
      now: () => Date.now(),
    });
    this.register(() => void this.mcp.dispose());
```
- in the `onLayoutReady` callback, right after `this.markReady();`:
```ts
      // After the startup check, so tools see the built index and the settled publisher role.
      void this.mcp.apply();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mcp test/main.test.ts test/mobile.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/service.ts src/settings/device.ts src/main.ts test/mcp/net.ts test/mcp/service.test.ts test/ui/ctx.ts test/main.test.ts
git commit -m "feat(mcp): server lifecycle, per-device token and desktop-only guard (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Read tools (#74)

**Files:**
- Create: `src/mcp/deps.ts`, `src/mcp/common.ts`, `src/mcp/present.ts`, `src/mcp/tools/read.ts`, `src/mcp/index.ts`, `test/mcp/helpers.ts`, `test/mcp/read.test.ts`
- Modify: `src/main.ts`, `test/ui/ctx.ts` (expose `factory`)

**Interfaces:**
- Consumes: `ToolRegistry`, `defineTool`, `ok`, `fail` (Task 1); `SocialIndex`, `IndexedVariant`, `IndexedCampaign`; `expandRows`, `unreadableRow`, `campaignProgress`, `RowStatus` (`src/index/queries.ts`); `PlannerActions.rows()/actionNotice()/openNote()`; `ComposerActions.content.load()/check()/counters()/media`; `PLATFORM_DEFS`, `platformDef`; `postItems`; `bodyOf`; `formatDateTime`, `parseDateTime`.
- Produces:
  - `interface McpToolDeps { app; index; channels; factory; writer; planner; composer; publish; secrets: { has(id): boolean }; settings(): OsmmSettings; now(): number; isPublisher(): boolean }` (Task 8 adds `approvals`).
  - `src/mcp/common.ts`: `zPath`, `zWhen` (ISO string → epoch ms), `zHttpUrl`, `zKey`, `zChannelsArg`, `normalizePathArg(path)`, `findPost(deps, path)`, `noPost(path)`, `clip(text, max)`, `untilIndexed(index, predicate, timeoutMs = 3000): Promise<boolean>`, `claudeNotice(deps, message, path)`.
  - `src/mcp/present.ts`: `iso(ms)`, `channelInfo(channel, credential)`, `channelRows(v, stagger, nameOf)`, `postSummary(v, stagger, nameOf)`, `campaignInfo(c, progress, posts)`, `platformRules(platform)`.
  - `registerReadTools(registry, deps)` with `list_channels`, `list_campaigns`, `get_campaign`, `list_posts`, `get_post`, `get_platform_rules`, `get_log`; `registerAllTools(registry, deps)` in `src/mcp/index.ts`.
  - Test helper `mcpCtx(opts?)` → `{ …TestCtx, deps, registry, call(name, args?) }` and `type R = any` in `test/mcp/helpers.ts`. `TestCtx.factory: NoteFactory`.

- [ ] **Step 1: Expose the factory in the test context and write the helper**

In `test/ui/ctx.ts`: add `factory: NoteFactory;` to `interface TestCtx` and `factory` to the returned object (`return { app, ctx, index, writer, settings, now: nowStore, adapters, log, publisher, factory };`).

`test/mcp/helpers.ts`:
```ts
import { get } from "svelte/store";
import { registerAllTools } from "../../src/mcp/index";
import type { McpToolDeps } from "../../src/mcp/deps";
import { ToolRegistry } from "../../src/mcp/tools";
import { Secrets } from "../../src/secrets/secrets";
import { makeCtx } from "../ui/ctx";

/** Tool results are JSON; tests read them loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type R = any;

export async function mcpCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  const c = await makeCtx({ seed: true, ...opts });
  const deps: McpToolDeps = {
    app: c.app as never,
    index: c.index,
    channels: c.ctx.channels,
    factory: c.factory,
    writer: c.writer,
    planner: c.ctx.actions,
    composer: c.ctx.composer,
    publish: c.ctx.publish,
    secrets: new Secrets(c.app as never),
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => c.publisher.isPublisher(),
  };
  const registry = new ToolRegistry({ redact: (text) => text });
  registerAllTools(registry, deps);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<R> => (await registry.call(name, args)).structuredContent;
  return { ...c, deps, registry, call };
}
```

- [ ] **Step 2: Write the failing tests**

`test/mcp/read.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { writeNote } from "../helpers";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";

describe("read tools (#74)", () => {
  it("lists channels and groups without credentials", async () => {
    const c = await mcpCtx();
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" });
    const all = await c.call("list_channels");
    expect(all.ok).toBe(true);
    expect(all.channels).toHaveLength(16);
    expect(all.channels.find((ch: R) => ch.id === "tg/event-x")).toMatchObject({ platform: "telegram", method: "api", credential: "missing" });
    expect(all.channels.find((ch: R) => ch.id === "li/me").credential).toBeNull();
    expect(all.groups).toEqual([{ id: "group:all-linkedin-pages", name: "All LinkedIn pages", channel_ids: ["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"] }]);
    expect((await c.call("list_channels", { platform: "linkedin" })).channels).toHaveLength(5);
    expect(JSON.stringify(all)).not.toContain("secretId");
  });

  it("lists active campaigns by anchor date with progress", async () => {
    const c = await mcpCtx();
    const { campaigns } = await c.call("list_campaigns");
    expect(campaigns.map((x: R) => x.title)).toEqual(["Event X", "OSMM launch"]);
    expect(campaigns[0]).toMatchObject({ path: EX, status: "active", posts: 9, deliveries_published: 1, anchor_date: "2026-10-12T18:00:00+02:00", link: "https://example.com/event-x" });
  });

  it("returns a campaign with its brief, posts and the platforms not planned yet", async () => {
    const c = await mcpCtx();
    const r = await c.call("get_campaign", { path: "Social/Event X/Event X" });
    expect(r.brief).toContain("[FILL IN]");
    expect(r.posts).toHaveLength(9);
    expect(r.missing_platforms).toEqual(["facebook", "mastodon", "indiehackers", "whatsapp"]);
    expect((await c.call("get_campaign", { path: "Social/Nope.md" })).error).toContain("list_campaigns");
  });

  it("filters and pages posts", async () => {
    const c = await mcpCtx();
    const first = await c.call("list_posts", { campaign: EX, limit: 3 });
    expect([first.total, first.posts.length, first.next_cursor]).toEqual([9, 3, "3"]);
    const rest = await c.call("list_posts", { campaign: EX, limit: 50, cursor: "3" });
    expect(rest.posts).toHaveLength(6);
    expect(rest.next_cursor).toBeNull();
    const overdue = await c.call("list_posts", { status: ["overdue"] });
    expect(overdue.posts.map((p: R) => p.path)).toEqual(["Social/Event X/Event X – Instagram.md"]);
    const today = await c.call("list_posts", { from: "2026-10-08T00:00:00+02:00", to: "2026-10-09T00:00:00+02:00" });
    expect(today.posts.map((p: R) => p.platform)).toEqual(["bluesky", "telegram", "linkedin"]);
    expect((await c.call("list_posts", { unscheduled: true })).posts.map((p: R) => p.title)).toEqual(
      expect.arrayContaining(["Show HN: OSMM – plan social posts in Obsidian", "WhatsApp reminder"]),
    );
  });

  it("returns invalid arguments as fields to fix", async () => {
    const c = await mcpCtx();
    const r = await c.call("list_posts", { limit: 1000, from: "next tuesday" });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.field).sort()).toEqual(["from", "limit"]);
  });

  it("returns one post with body, checks, counters and per-channel state", async () => {
    const c = await mcpCtx();
    const x = await c.call("get_post", { path: "Social/Event X/Event X – X.md" });
    expect(x).toMatchObject({ ok: true, platform: "x", status: "scheduled", thread_items: 3, blocking: false, mode: "auto" });
    expect(x.body).toContain("One evening, twelve makers");
    expect(x.counters[0]).toMatchObject({ label: "Part 1", limit: 280 });
    expect(x.channels).toEqual([{ id: "x/you", name: "@you", status: "scheduled", at: "2026-10-09T09:00:00+02:00" }]);
    const li = await c.call("get_post", { path: "Social/Event X/Event X – LinkedIn.md" });
    expect(li.channels.find((ch: R) => ch.id === "li/me")).toMatchObject({ status: "published", url: "https://www.linkedin.com/feed/update/urn:li:activity:1" });
    expect((await c.call("get_post", { path: "Social/Nope.md" })).error).toBe('No social post at "Social/Nope.md". Use list_posts to find the path.');
  });

  it("marks unreadable delivery entries as frozen", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Frozen.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me"], status: "scheduled", deliveries: { "li/me": { status: "publishd" } } }, body: "Hello" }],
    });
    const r = await c.call("get_post", { path: "Social/Posts/Frozen.md" });
    expect(r.channels[0]).toMatchObject({ id: "li/me", frozen: true });
    expect(r.issues.map((i: R) => i.code)).toContain("unreadable-delivery");
  });

  it("returns platform rules from the same numbers the checks use", async () => {
    const c = await mcpCtx();
    const { rules } = await c.call("get_platform_rules", { platform: "bluesky" });
    expect(rules).toEqual([expect.objectContaining({ platform: "bluesky", max_chars: 300, threads: true, thread_separator: "a line containing only ---", link: "optional" })]);
    expect((await c.call("get_platform_rules")).rules).toHaveLength(13);
  });

  it("reads the last lines of the publish log", async () => {
    const c = await mcpCtx();
    await writeNote(c.app as never, "Social/_log.md", null, "# Publish log\n\n- 2026-10-01T09:00:00+02:00 · Me (li/me) · [[A]] · published\n- 2026-10-02T09:00:00+02:00 · @you (x/you) · [[B]] · failed · 401\n- 2026-10-03T09:00:00+02:00 · Me (li/me) · [[C]] · skipped\n");
    expect((await c.call("get_log", { limit: 2 })).lines).toEqual(["2026-10-02T09:00:00+02:00 · @you (x/you) · [[B]] · failed · 401", "2026-10-03T09:00:00+02:00 · Me (li/me) · [[C]] · skipped"]);
    expect((await c.call("get_log", { contains: "LI/ME" })).total).toBe(2);
    expect(await c.call("get_log", { month: "2026-09" })).toEqual({ ok: true, path: "Social/_log/2026-09.md", total: 0, lines: [] });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/mcp/read.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/index'`.

- [ ] **Step 4: Write the shared pieces**

`src/mcp/deps.ts`:
```ts
import type { App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import type { ComposerActions } from "../composer/actions";
import type { SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import type { SafeWriter } from "../model/writer";
import type { PublishActions } from "../publish/actions";
import type { OsmmSettings } from "../settings/settings";
import type { PlannerActions } from "../ui/actions";

/** What MCP tools may use: the same services the UI uses, so every write keeps the plugin's rules. */
export interface McpToolDeps {
  app: App;
  index: SocialIndex;
  channels: ChannelRegistry;
  factory: NoteFactory;
  writer: SafeWriter;
  planner: PlannerActions;
  composer: ComposerActions;
  publish: PublishActions;
  /** Only whether a credential exists; tools never read secret values. */
  secrets: { has(id: string): boolean };
  settings(): OsmmSettings;
  now(): number;
  isPublisher(): boolean;
}
```

`src/mcp/common.ts`:
```ts
import { z } from "zod";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { parseDateTime } from "../model/dates";
import type { McpToolDeps } from "./deps";

export const zPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('Vault path of the note as the list tools return it, e.g. "Social/Event X/Event X – LinkedIn.md"');

export const zWhen = z
  .string()
  .trim()
  .max(40)
  .refine((s) => parseDateTime(s) !== null, "Use an ISO 8601 date-time such as 2026-10-08T17:30:00+02:00")
  .transform((s) => parseDateTime(s) as number);

export const zHttpUrl = z.string().trim().max(2000).regex(/^https?:\/\/\S+$/i, "Use an http(s) link");

export const zKey = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .describe("Any unique string, e.g. a UUID. Calling again with the same key returns the first result instead of creating a second note.")
  .optional();

export const zChannelsArg = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .describe('Channel ids from list_channels, such as "li/acme-studio", or "group:<id>" for every channel of a group');

/** Accepts paths with or without ".md" and without a leading slash. */
export function normalizePathArg(path: string): string {
  const p = path.trim().replace(/^\/+/, "");
  return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
}

export function findPost(deps: Pick<McpToolDeps, "index">, path: string): IndexedVariant | undefined {
  return deps.index.getVariant(normalizePathArg(path));
}

export const noPost = (path: string): string => `No social post at "${path}". Use list_posts to find the path.`;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

/** Waits until the index shows a write (or the timeout passes), so the next read tool sees it. */
export function untilIndexed(index: SocialIndex, predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(predicate());
    }, timeoutMs);
    const off = index.onChange(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/** Every write by Claude is visible in Obsidian, with a way to look at it. */
export function claudeNotice(deps: Pick<McpToolDeps, "planner">, message: string, path: string): void {
  deps.planner.actionNotice(message, "Open", () => deps.planner.openNote(path));
}
```

`src/mcp/present.ts`:
```ts
import { expandRows, unreadableRow } from "../index/queries";
import type { IndexedCampaign, IndexedVariant } from "../index/socialIndex";
import { formatDateTime } from "../model/dates";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel } from "../model/types";
import { PLATFORM_DEFS } from "../platforms/registry";

export const iso = (ms: number | undefined): string | null => (ms === undefined ? null : formatDateTime(ms));

export function channelInfo(c: Channel, credential: "set" | "missing" | null) {
  return {
    id: c.id,
    platform: c.platform,
    name: c.name,
    kind: c.kind,
    handle: c.handle ?? null,
    method: c.method,
    default_time: c.defaultTime ?? null,
    default_reminders: c.defaultReminders ?? null,
    max_chars: c.maxChars ?? null,
    credential,
  };
}

/** One entry per listed channel: its row status and time, the live link or error, and whether it is frozen. */
export function channelRows(v: IndexedVariant, stagger: number, nameOf: (id: string) => string) {
  return expandRows([v], stagger)
    .filter((r) => r.channelId !== null)
    .map((r) => {
      const id = r.channelId as string;
      const d = v.deliveries[id];
      return {
        id,
        name: nameOf(id),
        status: r.status,
        at: iso(r.at),
        ...(d?.url ? { url: d.url } : {}),
        ...(d?.error ? { error: d.error } : {}),
        ...(unreadableRow(r) ? { frozen: true } : {}),
      };
    });
}

export function postSummary(v: IndexedVariant, stagger: number, nameOf: (id: string) => string) {
  return {
    path: v.path,
    title: v.displayTitle,
    platform: v.platform,
    campaign: v.campaignPath ?? null,
    status: v.status,
    scheduled_at: iso(v.scheduledAt),
    excerpt: v.excerpt,
    chars: v.bodyChars,
    channels: channelRows(v, stagger, nameOf),
  };
}

export function campaignInfo(c: IndexedCampaign, progress: { published: number; total: number }, posts: number) {
  return {
    path: c.path,
    title: c.title,
    status: c.status,
    anchor_date: iso(c.anchorDate),
    link: c.link ?? null,
    posts,
    deliveries_published: progress.published,
    deliveries_total: progress.total,
  };
}

export function platformRules(p: Platform) {
  const def = PLATFORM_DEFS[p];
  const { limits, media, threads } = def.capabilities;
  return {
    platform: p,
    label: PLATFORM_META[p].label,
    channel_prefix: `${PLATFORM_META[p].prefix}/`,
    max_chars: limits.maxChars,
    counter: limits.counter,
    max_chars_with_media: limits.maxCharsWithMedia ?? null,
    fold_at: limits.foldAt ?? null,
    title_required: limits.titleRequired === true,
    title_max: limits.titleMax ?? null,
    link: limits.link,
    max_hashtags: limits.maxHashtags ?? null,
    threads,
    thread_separator: threads ? "a line containing only ---" : null,
    text_format: def.dialect,
    media: { max_count: media.maxCount, required: media.required, max_bytes: media.maxBytes, ratio: media.ratio ?? null },
    api: def.capabilities.api,
    native_schedule: def.capabilities.nativeSchedule,
  };
}
```

- [ ] **Step 5: Write the read tools**

`src/mcp/tools/read.ts`:
```ts
import { normalizePath } from "obsidian";
import { z } from "zod";
import { campaignProgress } from "../../index/queries";
import type { IndexedVariant } from "../../index/socialIndex";
import { bodyOf } from "../../model/body";
import { PLATFORMS } from "../../model/platforms";
import { DELIVERY_STATUSES } from "../../model/schemas";
import { blocking } from "../../platforms/checks";
import { platformDef } from "../../platforms/registry";
import { postItems } from "../../platforms/text";
import { clip, findPost, noPost, normalizePathArg, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { campaignInfo, channelInfo, platformRules, postSummary } from "../present";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const ROW_STATUSES = [...DELIVERY_STATUSES, "idea"] as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

const byTime = (a: IndexedVariant, b: IndexedVariant): number =>
  (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path);

export function registerReadTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const stagger = () => deps.settings().defaultStaggerMinutes;
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;

  registry.add(
    defineTool({
      name: "list_channels",
      title: "List channels",
      description:
        "The accounts, pages, groups and sites posts can go to: id (such as li/acme-studio), platform, name, publish method (api, native or assisted), usual posting time and default reminders. Also the channel groups; pass group:<id> wherever channels are asked for. Never returns credentials.",
      input: z.object({ platform: z.enum(PLATFORMS).optional() }).strict(),
      annotations: READ,
      run: async ({ platform }) => {
        const list = platform ? deps.channels.byPlatform(platform) : deps.channels.list();
        const channels = list.map((c) => channelInfo(c, c.secretId ? (deps.secrets.has(c.secretId) ? "set" : "missing") : null));
        const groups = deps.channels.groups().map((g) => ({ id: `group:${g.id}`, name: g.name, channel_ids: g.channelIds }));
        return ok({ channels, groups });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "list_campaigns",
      title: "List campaigns",
      description: "Campaign notes, ordered by anchor date (the event or launch date), with how many posts each has and how many deliveries are published.",
      input: z.object({ status: z.enum(["active", "archived", "all"]).default("active") }).strict(),
      annotations: READ,
      run: async ({ status }) => {
        const variants = deps.index.variants();
        const campaigns = deps.index
          .campaigns()
          .filter((c) => status === "all" || c.status === status)
          .sort((a, b) => (a.anchorDate ?? Number.POSITIVE_INFINITY) - (b.anchorDate ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path))
          .map((c) => campaignInfo(c, campaignProgress(variants, c.path), deps.index.variantsOf(c.path).length));
        return ok({ campaigns });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_campaign",
      title: "Get a campaign",
      description:
        "One campaign: its fields, the brief (the note's text), every post with per-channel status, and the platforms that have channels but no post in this campaign yet.",
      input: z.object({ path: zPath }).strict(),
      annotations: READ,
      run: async ({ path }) => {
        const c = deps.index.getCampaign(normalizePathArg(path));
        if (!c) return fail(`No campaign note at "${path}". Use list_campaigns to find the path.`);
        const variants = deps.index.variantsOf(c.path).sort(byTime);
        const present = new Set(variants.map((v) => v.platform));
        const configured = new Set(deps.channels.list().map((ch) => ch.platform));
        return ok({
          campaign: campaignInfo(c, campaignProgress(deps.index.variants(), c.path), variants.length),
          brief: clip(bodyOf(await deps.app.vault.cachedRead(c.file)).trim(), 20_000),
          note_issues: c.issues,
          posts: variants.map((v) => postSummary(v, stagger(), nameOf)),
          missing_platforms: PLATFORMS.filter((p) => configured.has(p) && !present.has(p)),
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "list_posts",
      title: "List posts",
      description:
        "Posts (platform variants), filtered by campaign, platform, channel, row status or a time range [from, to), ordered by their earliest delivery. Pages with limit and next_cursor. Use get_post for the text.",
      input: z
        .object({
          campaign: zPath.optional().describe("Only the posts of this campaign note"),
          platform: z.enum(PLATFORMS).optional(),
          channel: z.string().trim().max(80).optional().describe("Only posts going to this channel id"),
          status: z.array(z.enum(ROW_STATUSES)).max(12).optional().describe("Per-channel statuses to include, e.g. [\"scheduled\", \"overdue\"]"),
          from: zWhen.optional(),
          to: zWhen.optional(),
          unscheduled: z.boolean().optional().describe("Only channels without a time"),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().regex(/^\d{1,6}$/).optional().describe("next_cursor from the previous page"),
        })
        .strict(),
      annotations: READ,
      run: async (a) => {
        if (a.from !== undefined && a.to !== undefined && a.to <= a.from) return fail("to must be after from.");
        const campaign = a.campaign ? normalizePathArg(a.campaign) : undefined;
        if (campaign && !deps.index.getCampaign(campaign)) return fail(`No campaign note at "${a.campaign}". Use list_campaigns to find the path.`);
        const rows = deps.planner.rows().filter((r) => {
          if (campaign && r.variant.campaignPath !== campaign) return false;
          if (a.platform && r.variant.platform !== a.platform) return false;
          if (a.channel && r.channelId !== a.channel) return false;
          if (a.status && !a.status.includes(r.status)) return false;
          if (a.unscheduled && r.at !== undefined) return false;
          if (a.from !== undefined && (r.at === undefined || r.at < a.from)) return false;
          if (a.to !== undefined && (r.at === undefined || r.at >= a.to)) return false;
          return true;
        });
        const first = new Map<string, { v: IndexedVariant; at: number }>();
        for (const r of rows) {
          const at = r.at ?? Number.POSITIVE_INFINITY;
          const seen = first.get(r.variant.path);
          if (!seen || at < seen.at) first.set(r.variant.path, { v: r.variant, at });
        }
        const ordered = [...first.values()].sort((x, y) => x.at - y.at || x.v.path.localeCompare(y.v.path));
        const offset = a.cursor ? Number(a.cursor) : 0;
        const page = ordered.slice(offset, offset + a.limit);
        return ok({
          total: ordered.length,
          posts: page.map(({ v }) => postSummary(v, stagger(), nameOf)),
          next_cursor: offset + a.limit < ordered.length ? String(offset + a.limit) : null,
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_post",
      title: "Get a post",
      description:
        "One post: fields, body (Markdown; on X, Mastodon and Bluesky a line with only --- starts the next thread item), per-channel status, the plugin's checks (issues, blocking) and the length counters.",
      input: z.object({ path: zPath }).strict(),
      annotations: READ,
      run: async ({ path }) => {
        const v = findPost(deps, path);
        if (!v) return fail(noPost(path));
        const content = await deps.composer.content.load(v);
        const issues = deps.composer.check(v, content);
        const def = platformDef(v.platform);
        const wp = v.wordpress;
        return ok({
          ...postSummary(v, stagger(), nameOf),
          mode: v.mode,
          reminders: v.reminders ?? null,
          stagger_minutes: v.staggerMinutes ?? null,
          url: v.url ?? null,
          media: v.media,
          ...(wp
            ? { wordpress: { slug: wp.slug ?? null, excerpt: wp.excerpt ?? null, categories: wp.categories, tags: wp.tags, featured_image: wp.featuredImage ?? null } }
            : {}),
          body: clip(content.body, 100_000),
          thread_items: def.capabilities.threads ? postItems(content.body, def).length : null,
          note_issues: v.issues,
          issues,
          blocking: blocking(issues),
          counters: deps.composer.counters(v, content),
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_platform_rules",
      title: "Get platform rules",
      description:
        "Limits the plugin checks per platform: characters (and how they are counted), fold, title, link, hashtags, media, threads and the text format. Read before drafting.",
      input: z.object({ platform: z.enum(PLATFORMS).optional() }).strict(),
      annotations: READ,
      run: async ({ platform }) => ok({ rules: (platform ? [platform] : [...PLATFORMS]).map(platformRules) }),
    }),
  );

  registry.add(
    defineTool({
      name: "get_log",
      title: "Read the publish log",
      description: "The last lines of the publish log (Social/_log.md): time · channel · post · result · link or error. month reads an archived month.",
      input: z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          contains: z.string().trim().min(1).max(200).optional().describe("Only lines containing this text (case-insensitive)"),
          month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("An archived month, e.g. 2026-09"),
        })
        .strict(),
      annotations: READ,
      run: async (a) => {
        const root = deps.settings().rootFolder;
        const path = normalizePath(a.month ? `${root}/_log/${a.month}.md` : `${root}/_log.md`);
        const file = deps.app.vault.getFileByPath(path);
        if (!file) return ok({ path, total: 0, lines: [] });
        const needle = a.contains?.toLowerCase();
        const lines = (await deps.app.vault.cachedRead(file))
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2))
          .filter((l) => !needle || l.toLowerCase().includes(needle));
        return ok({ path, total: lines.length, lines: lines.slice(-a.limit) });
      },
    }),
  );
}
```

`src/mcp/index.ts`:
```ts
import type { McpToolDeps } from "./deps";
import { registerReadTools } from "./tools/read";
import type { ToolRegistry } from "./tools";

/** Every MCP tool (spec §6.1). Later tasks add their groups here. */
export function registerAllTools(registry: ToolRegistry, deps: McpToolDeps): void {
  registerReadTools(registry, deps);
}
```

- [ ] **Step 6: Register the tools in the plugin**

In `src/main.ts`, add `import { registerAllTools } from "./mcp/index";` and, right after the `this.tools = new ToolRegistry({ … });` statement from Task 3:
```ts
    registerAllTools(this.tools, {
      app: this.app,
      index: this.index,
      channels: this.channels,
      factory: this.factory,
      writer: this.writer,
      planner: ui.actions,
      composer: ui.composer,
      publish: ui.publish,
      secrets: this.secrets,
      settings: () => this.settings,
      now: () => Date.now(),
      isPublisher: () => this.publisher.isPublisher(),
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/mcp && npm run typecheck && npm run lint`
Expected: PASS. If a seed expectation differs (for example the order of today's posts), check it against `scripts/seedData.ts` and `TEST_NOW` before changing either side, and report it.

- [ ] **Step 8: Commit**

```bash
git add src/mcp test/mcp src/main.ts test/ui/ctx.ts
git commit -m "feat(mcp): read tools for channels, campaigns, posts, platform rules and the log (#74)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Write tools — create, update, fork, validate (#75, part 1)

**Files:**
- Create: `src/mcp/idempotency.ts`, `src/mcp/tools/write.ts`, `test/mcp/write.test.ts`
- Modify: `src/model/writer.ts` (`editBody`), `src/model/factory.ts` (`brief`, fork guard), `src/composer/channels.ts` (`planSetChannels`), `src/mcp/index.ts`, `test/model/writer.test.ts`, `test/model/factory.test.ts`, `test/composer/channels.test.ts`

**Interfaces:**
- Consumes: `McpToolDeps`, `zPath`, `zWhen`, `zHttpUrl`, `zKey`, `zChannelsArg`, `findPost`, `noPost`, `normalizePathArg`, `untilIndexed`, `claudeNotice` (Task 4); `NoteFactory.createCampaign/createVariant/forkVariant`; `PlannerActions.write` (fresh frontmatter, records); `SafeWriter.patchVariant/setFields`; `ComposerActions.check/media/content/counters`; `validateAll`, `blocking`, `counters`; `ChannelRegistry.expand`, `GROUP_PREFIX`.
- Produces:
  - `SafeWriter.editBody(file, edit: (body: string) => string): Promise<void>` — replaces the body in the same per-file queue as frontmatter writes; the frontmatter block is kept byte for byte.
  - `NoteFactory.createCampaign({ title, anchorDate?, link?, brief? })`; `forkVariant` throws `"<id>'s delivery entry can't be read. Fix its status in the note before forking it."` for an unreadable channel.
  - `planSetChannels(fresh: Variant, desired: readonly Pick<Channel, "id" | "name" | "platform">[], nameOf: (id: string) => string): VariantUpdate | { refuse: string }`.
  - `class IdempotencyCache { constructor(now, ttlMs = DAY, max = 500); run(scope, key | undefined, fn, stillValid?): Promise<ToolOutcome> }` — a replay returns the first outcome with `replayed: true`; failures are not kept.
  - `registerWriteTools(registry, deps)`: `create_campaign`, `create_variant`, `update_variant`, `fork_variant`, `validate`; exported helpers `BLOCKED`, `resolveChannels(deps, ids, platform)`, `wordpressFields(wp)`, `pendingDeliveries(v)`.

- [ ] **Step 1: Write the failing model tests**

Add to `test/model/writer.test.ts` (inside `describe("SafeWriter", …)`):
```ts
  it("replaces the body and keeps the frontmatter byte for byte, in the same queue as field writes", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "publishd" } } }, "Old body\n");
    const writer = new SafeWriter(app);
    await Promise.all([writer.setFields(file, { title: "T" }), writer.editBody(file, (body) => `${body.trim()} and more`)]);
    expect((await app.vault.read(file)).endsWith("---\nOld body and more\n")).toBe(true);
    expect((await fmOf(app, file)).title).toBe("T");
    const head = (text: string) => text.slice(0, getFrontMatterInfo(text).contentStart);
    const before = head(await app.vault.read(file));
    await writer.editBody(file, () => "New");
    const after = await app.vault.read(file);
    expect(head(after)).toBe(before);
    expect(after.endsWith("---\nNew\n")).toBe(true);
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });
```

Add to `test/model/factory.test.ts` (inside `describe("NoteFactory", …)`):
```ts
  it("writes the brief into a new campaign", async () => {
    const { app, factory } = setup();
    const file = await factory.createCampaign({ title: "Event Y", brief: "Monthly makers evening.\nFree." });
    expect(await app.vault.read(file)).toContain("## Brief\n\nMonthly makers evening.\nFree.\n\n## Variants\n\n```social-variants\n```\n");
  });

  it("refuses to fork a channel whose delivery entry can't be read (frozen)", async () => {
    const { app, factory } = setup();
    const file = await writeNote(app, "Social/P.md", { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme"], status: "scheduled", deliveries: { "li/me": { status: "publishd" } } }, "Body\n");
    await expect(factory.forkVariant(file, "li/me", "Me")).rejects.toThrow("li/me's delivery entry can't be read");
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "publishd" } });
    expect((await fmOf(app, file)).channels).toEqual(["li/me", "li/acme"]);
  });
```

Add to `test/composer/channels.test.ts` (import `planSetChannels` next to the existing imports):
```ts
describe("planSetChannels", () => {
  const nameOf = (id: string) => ({ "li/me": "Me", "li/acme": "Acme" })[id] ?? id;

  it("replaces the list, keeping the order of the channels that stay", () => {
    expect(planSetChannels(v(), [ch("li/acme"), ch("li/osmm")], nameOf)).toEqual({ fields: { channels: ["li/acme", "li/osmm"] } });
  });

  it("adds with the inherited status and removes records of dropped channels", () => {
    const scheduled = v({ status: "scheduled", scheduledAt: 1, deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled" } } });
    expect(planSetChannels(scheduled, [ch("li/me"), ch("li/osmm")], nameOf)).toEqual({
      fields: { channels: ["li/me", "li/osmm"] },
      deliveries: { "li/acme": null, "li/osmm": { status: "scheduled" } },
    });
  });

  it("keeps history: published, awaiting and unreadable channels stay", () => {
    expect(planSetChannels(v({ deliveries: { "li/me": { status: "published" } } }), [ch("li/acme")], nameOf)).toEqual({ refuse: "Me was already published, so it stays on this post." });
    expect(planSetChannels(v({ deliveries: { "li/me": { status: "awaiting_you" } } }), [ch("li/acme")], nameOf)).toEqual({ refuse: "Me is awaiting you to post manually, so it stays on this post." });
    expect(planSetChannels(v({ invalidDeliveries: ["li/me"] }), [ch("li/acme")], nameOf)).toEqual({ refuse: "Me's delivery status can't be read from the note, so it stays on this post until you fix it." });
  });

  it("refuses another platform's channel and an empty list on a scheduled post", () => {
    expect(planSetChannels(v(), [ch("x/you", "@you", "x")], nameOf)).toEqual({ refuse: "@you is not a LinkedIn channel." });
    expect(planSetChannels(v({ status: "scheduled", scheduledAt: 1 }), [], nameOf)).toEqual({ refuse: "A scheduled post needs at least one channel. Unschedule it first." });
  });
});
```

- [ ] **Step 2: Write the failing tool tests**

`test/mcp/write.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";
const LI = "Social/Event X/Event X – LinkedIn.md";

async function fm(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}
async function body(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<string> {
  const text = await c.app.vault.read(c.app.vault.getFileByPath(path)!);
  return text.slice(getFrontMatterInfo(text).contentStart);
}

describe("create_campaign", () => {
  it("creates the note with the brief and shows a notice", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_campaign", { title: "Event Y", anchor_date: "2026-11-05T18:00:00+01:00", link: "https://example.com/y", brief: "A makers evening." });
    expect(r).toMatchObject({ ok: true, path: "Social/Event Y/Event Y.md" });
    expect(c.index.getCampaign(r.path)?.anchorDate).toBe(Date.parse("2026-11-05T18:00:00+01:00"));
    expect(await body(c, r.path)).toContain("A makers evening.");
  });

  it("returns the first note when retried with the same key, even concurrently (review focus 2)", async () => {
    const c = await mcpCtx();
    const key = "7f9c2c1e-retry-key";
    const [a, b] = await Promise.all([c.call("create_campaign", { title: "Event Z", idempotency_key: key }), c.call("create_campaign", { title: "Event Z", idempotency_key: key })]);
    const again = await c.call("create_campaign", { title: "Event Z", idempotency_key: key });
    expect([a.path, b.path, again.path]).toEqual(["Social/Event Z/Event Z.md", "Social/Event Z/Event Z.md", "Social/Event Z/Event Z.md"]);
    expect(again.replayed).toBe(true);
    expect(c.app.vault.getFileByPath("Social/Event Z/Event Z 2.md")).toBeNull();
  });
});

describe("create_variant", () => {
  it("creates a draft for a campaign, expanding a channel group", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_variant", { platform: "linkedin", campaign: EX, channels: ["group:all-linkedin-pages"], body: "Event X is back on the 12th.", scheduled_at: "2026-10-10T09:00:00+02:00" });
    expect(r).toMatchObject({ ok: true, path: "Social/Event X/Event X – LinkedIn 2.md", status: "draft" });
    const v = c.index.getVariant(r.path)!;
    expect(v.channels).toEqual(["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    expect([v.status, v.scheduledAt, v.campaignPath]).toEqual(["draft", Date.parse("2026-10-10T09:00:00+02:00"), EX]);
    expect(await body(c, r.path)).toBe("Event X is back on the 12th.\n");
  });

  it("writes nothing on a blocking issue unless force_draft", async () => {
    const c = await mcpCtx();
    const long = { platform: "x", campaign: EX, channels: ["x/you"], body: "a".repeat(300) };
    const refused = await c.call("create_variant", long);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("nothing was written");
    expect(refused.issues.map((i: R) => i.code)).toContain("too-long");
    expect(c.app.vault.getFileByPath("Social/Event X/Event X – X 2.md")).toBeNull();
    const forced = await c.call("create_variant", { ...long, force_draft: true });
    expect(forced).toMatchObject({ ok: true, path: "Social/Event X/Event X – X 2.md", status: "draft" });
  });

  it("never writes with an unknown channel, even with force_draft", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_variant", { platform: "linkedin", title: "Solo", channels: ["li/nope", "x/you"], body: "Hi", force_draft: true });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.message)).toEqual(["Unknown channel li/nope. Use list_channels.", "x/you is not a LinkedIn channel."]);
  });

  it("needs a title outside a campaign and writes WordPress fields per key", async () => {
    const c = await mcpCtx();
    expect((await c.call("create_variant", { platform: "mastodon", channels: ["ma/you"], body: "Hi" })).error).toBe("A post outside a campaign needs a title.");
    const wp = await c.call("create_variant", {
      platform: "wordpress",
      campaign: EX,
      title: "Event X recap",
      channels: ["wp/eventx-berlin"],
      body: "# Recap\n\nWhat 80 makers shipped.",
      wordpress: { slug: "event-x-recap", excerpt: "What 80 makers shipped.", categories: ["Community"], tags: ["events"] },
    });
    expect(wp.ok).toBe(true);
    expect(await fm(c, wp.path)).toMatchObject({ slug: "event-x-recap", excerpt: "What 80 makers shipped.", categories: ["Community"], tags: ["events"] });
    expect(wp.issues.map((i: R) => i.code)).toContain("missing-featured");
  });
});

describe("update_variant", () => {
  it("edits text and fields, keeps every delivery entry verbatim and warns about live channels", async () => {
    const c = await mcpCtx();
    const before = (await fm(c, LI)).deliveries;
    const r = await c.call("update_variant", { path: LI, title: "Event X is back", body: "I almost didn't host Event X. Here is why." });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.issues).toEqual([expect.objectContaining({ level: "warning", code: "already-live" })]);
    expect((await fm(c, LI)).deliveries).toEqual(before);
    expect((await fm(c, LI)).title).toBe("Event X is back");
    expect(await body(c, LI)).toBe("I almost didn't host Event X. Here is why.\n");
  });

  it("keeps channel history when replacing the list", async () => {
    const c = await mcpCtx();
    const r = await c.call("update_variant", { path: LI, channels: ["li/maker-lab"] });
    expect(r.error).toBe("Me was already published, so it stays on this post.");
  });

  it("refuses force_draft on a scheduled post and allows it on a draft", async () => {
    const c = await mcpCtx();
    const long = "a".repeat(3100);
    const scheduled = await c.call("update_variant", { path: LI, body: long, force_draft: true });
    expect(scheduled.error).toContain("call unschedule first");
    expect(await body(c, LI)).not.toContain(long);
    const recap = "Social/Event X/Event X – LinkedIn recap.md";
    const draft = await c.call("update_variant", { path: recap, body: long, force_draft: true });
    expect(draft.ok).toBe(true);
    expect(draft.issues.map((i: R) => i.code)).toContain("too-long");
  });

  it("leaves an unreadable delivery entry untouched", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Frozen.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me"], status: "draft", deliveries: { "li/me": { status: "publishd" } } }, body: "Hello" }],
    });
    const r = await c.call("update_variant", { path: "Social/Posts/Frozen.md", title: "Still frozen", force_draft: true });
    expect(r.ok).toBe(true);
    expect((await fm(c, "Social/Posts/Frozen.md")).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });

  it("refuses WordPress fields on another platform", async () => {
    const c = await mcpCtx();
    expect((await c.call("update_variant", { path: LI, wordpress: { slug: "x" } })).error).toBe("wordpress fields are only for platform wordpress.");
  });
});

describe("fork_variant and validate", () => {
  it("forks one channel into its own note", async () => {
    const c = await mcpCtx();
    const r = await c.call("fork_variant", { path: LI, channel: "li/maker-lab" });
    expect(r).toMatchObject({ ok: true, path: "Social/Event X/Event X – LinkedIn – Maker Lab.md", original: LI });
    expect(c.index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio"]);
  });

  it("validates a note or a draft without writing", async () => {
    const c = await mcpCtx();
    expect(await c.call("validate", { path: "Social/Event X/Event X – X.md" })).toMatchObject({ ok: true, blocking: false });
    const draft = await c.call("validate", { draft: { platform: "x", channels: ["x/you"], body: "a".repeat(300) } });
    expect(draft).toMatchObject({ ok: true, blocking: true });
    expect(draft.issues.map((i: R) => i.code)).toContain("too-long");
    expect(draft.counters[0]).toEqual({ label: "Length", value: 300, limit: 280 });
    expect((await c.call("validate", {})).error).toBe("Pass either path or draft.");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/model/writer.test.ts test/model/factory.test.ts test/composer/channels.test.ts test/mcp/write.test.ts`
Expected: FAIL — `writer.editBody is not a function`, `planSetChannels` not exported, `create_campaign` unknown.

- [ ] **Step 4: Add `editBody` to the SafeWriter**

In `src/model/writer.ts`, import `getFrontMatterInfo` (`import { getFrontMatterInfo, type App, type TFile } from "obsidian";`) and replace `run()` with a shared queue plus the new method:
```ts
  /** One queue per file (object identity), for frontmatter and body writes alike. */
  private enqueue<T>(file: TFile, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  }

  run<T>(file: TFile, fn: (fm: Frontmatter) => T): Promise<T> {
    return this.enqueue(file, async () => {
      let result!: T;
      await this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => {
        result = fn(fm);
      });
      return result;
    });
  }

  /** Replaces the note's body; the frontmatter block is kept exactly as it is. */
  editBody(file: TFile, edit: (body: string) => string): Promise<void> {
    return this.enqueue(file, async () => {
      await this.app.vault.process(file, (content) => {
        const info = getFrontMatterInfo(content);
        const head = info.exists ? content.slice(0, info.contentStart) : "";
        const next = edit(info.exists ? content.slice(info.contentStart) : content);
        return head + (next.endsWith("\n") ? next : `${next}\n`);
      });
    });
  }
```

- [ ] **Step 5: Extend the factory**

In `src/model/factory.ts`:
- `createCampaign(input: { title: string; anchorDate?: number; link?: string; brief?: string })`, and replace the `body` line with:
```ts
    const brief = input.brief?.trim();
    const body = brief
      ? `\n## Brief\n\n${brief}\n\n## Variants\n\n\`\`\`social-variants\n\`\`\`\n`
      : "\n## Brief\n\n\n## Variants\n\n```social-variants\n```\n";
```
- in `forkVariant`, inside the `writer.run` callback, right after the `if (!current) throw …` line:
```ts
      // Frozen: the fork would drop the raw entry and the channel could be posted again.
      if (current.invalidDeliveries?.includes(channelId)) throw new Error(`${channelId}'s delivery entry can't be read. Fix its status in the note before forking it.`);
```

- [ ] **Step 6: Add `planSetChannels`**

Append to `src/composer/channels.ts`:
```ts
/**
 * Replaces the channel list in one plan (MCP update_variant): removals follow planToggleChannel's rules (a channel
 * with history, or an unreadable entry, stays), additions inherit the post's status like withChannels.
 */
export function planSetChannels(
  fresh: Variant,
  desired: readonly Pick<Channel, "id" | "name" | "platform">[],
  nameOf: (id: string) => string,
): VariantUpdate | { refuse: string } {
  const wrong = desired.find((c) => c.platform !== fresh.platform);
  if (wrong) return { refuse: `${wrong.name} is not a ${PLATFORM_META[fresh.platform].label} channel.` };
  const ids = [...new Set(desired.map((c) => c.id))];
  const deliveries: Record<string, Delivery | null> = {};
  for (const id of fresh.channels.filter((c) => !ids.includes(c))) {
    if (fresh.invalidDeliveries?.includes(id)) return { refuse: `${nameOf(id)}'s delivery status can't be read from the note, so it stays on this post until you fix it.` };
    const d = fresh.deliveries[id];
    const why = d ? STAYS[d.status] : !hasRecords(fresh) && PUBLISHED.has(fresh.status) ? STAYS.published : undefined;
    if (why) return { refuse: `${nameOf(id)} ${why}, so it stays on this post.` };
    if (d) deliveries[id] = null;
  }
  const added = ids.filter((id) => !fresh.channels.includes(id));
  const channels = [...fresh.channels.filter((c) => ids.includes(c)), ...added];
  if (!channels.length && fresh.scheduledAt !== undefined && SCHEDULED.has(fresh.status)) {
    return { refuse: "A scheduled post needs at least one channel. Unschedule it first." };
  }
  if (added.length) Object.assign(deliveries, withChannels(fresh, added).deliveries ?? {});
  return Object.keys(deliveries).length ? { fields: { channels }, deliveries } : { fields: { channels } };
}
```

- [ ] **Step 7: Write the idempotency cache**

`src/mcp/idempotency.ts`:
```ts
import { DAY } from "../model/dates";
import type { ToolOutcome } from "./tools";

/**
 * Remembers what a write with an idempotency key produced (#75), so a retry after a timeout returns the first
 * result instead of creating a second note. In memory only: 24 hours, at most 500 keys, forgotten on reload.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, { at: number; result: Promise<ToolOutcome> }>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = DAY,
    private readonly max = 500,
  ) {}

  run(scope: string, key: string | undefined, fn: () => Promise<ToolOutcome>, stillValid: (o: ToolOutcome) => boolean = () => true): Promise<ToolOutcome> {
    if (!key) return fn();
    const id = `${scope}\u0000${key}`;
    this.prune();
    const hit = this.entries.get(id);
    if (!hit) return this.fresh(id, fn);
    return hit.result.then((o) => {
      if (!stillValid(o)) return this.fresh(id, fn);
      return o.ok ? { ok: true, data: { ...o.data, replayed: true } } : o;
    });
  }

  private fresh(id: string, fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const result = fn().then(
      (o) => {
        if (!o.ok) this.entries.delete(id);
        return o;
      },
      (e: unknown) => {
        this.entries.delete(id);
        throw e;
      },
    );
    this.entries.set(id, { at: this.now(), result });
    return result;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.entries) if (e.at < cutoff) this.entries.delete(id);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
```

- [ ] **Step 8: Write the write tools**

`src/mcp/tools/write.ts`:
```ts
import { z } from "zod";
import { GROUP_PREFIX } from "../../channels/registry";
import { planSetChannels } from "../../composer/channels";
import { channelRowStatus, type RowStatus } from "../../index/queries";
import type { VariantPatch } from "../../model/frontmatter";
import { PLATFORM_META, PLATFORMS, type Platform } from "../../model/platforms";
import { POST_MODES, zMinutesList } from "../../model/schemas";
import type { Channel, Issue, Variant, WordPressFields } from "../../model/types";
import { blocking } from "../../platforms/checks";
import { claudeNotice, findPost, noPost, normalizePathArg, untilIndexed, zChannelsArg, zHttpUrl, zKey, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { IdempotencyCache } from "../idempotency";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

export const BLOCKED = "Blocking issues, so nothing was written. Fix them, or pass force_draft: true to save the post as a draft anyway.";
const PENDING = new Set<RowStatus>(["scheduled", "awaiting_you", "handed_over", "overdue"]);
const LIVE = new Set<string>(["published", "handed_over"]);

const zBody = z.string().max(100_000).describe("Markdown. On X, Mastodon and Bluesky a line with only --- starts the next thread item.");
const zMedia = z.array(z.string().trim().min(1).max(300)).max(20).describe('Vault images by file name or path, e.g. "event-x-cover.png"');
const zWordPress = z
  .object({
    slug: z.string().trim().max(200).optional(),
    excerpt: z.string().trim().max(1_000).optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    featured_image: z.string().trim().max(300).optional().describe("A vault image, e.g. event-x-cover.png"),
  })
  .strict()
  .describe("WordPress only: slug, excerpt, categories, tags and featured image");
type WordPressInput = z.infer<typeof zWordPress>;

/** Channel ids (or group:<id>) → channels of `platform`; unknown or foreign ids become blocking issues. */
export function resolveChannels(deps: Pick<McpToolDeps, "channels">, ids: readonly string[], platform: Platform): { channels: Channel[]; issues: Issue[] } {
  const channels: Channel[] = [];
  const issues: Issue[] = [];
  for (const raw of ids) {
    const expanded = deps.channels.expand([raw]);
    if (!expanded.length) {
      issues.push({ level: "error", field: "channels", code: "unknown-channel", message: `Unknown channel ${raw}. Use list_channels.` });
      continue;
    }
    for (const id of expanded) {
      const channel = deps.channels.get(id);
      if (!channel) continue;
      if (channel.platform !== platform) {
        // A group may mix platforms; only a channel named directly is a mistake.
        if (!raw.startsWith(GROUP_PREFIX)) issues.push({ level: "error", field: "channels", code: "wrong-platform", message: `${id} is not a ${PLATFORM_META[platform].label} channel.` });
        continue;
      }
      if (!channels.includes(channel)) channels.push(channel);
    }
  }
  return { channels, issues };
}

/** Frontmatter keys for the WordPress fields that were passed ("" removes a key). */
export function wordpressFields(wp: WordPressInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (wp.slug !== undefined) out.slug = wp.slug || undefined;
  if (wp.excerpt !== undefined) out.excerpt = wp.excerpt || undefined;
  if (wp.categories) out.categories = wp.categories;
  if (wp.tags) out.tags = wp.tags;
  if (wp.featured_image !== undefined) out.featured_image = wp.featured_image ? `[[${wp.featured_image}]]` : undefined;
  return out;
}

function mergeWordPress(current: WordPressFields | undefined, wp: WordPressInput | undefined): WordPressFields {
  return {
    slug: wp?.slug !== undefined ? wp.slug || undefined : current?.slug,
    excerpt: wp?.excerpt !== undefined ? wp.excerpt || undefined : current?.excerpt,
    categories: wp?.categories ?? current?.categories ?? [],
    tags: wp?.tags ?? current?.tags ?? [],
    featuredImage: wp?.featured_image !== undefined ? wp.featured_image || undefined : current?.featuredImage,
  };
}

/** A post with deliveries still to happen (or waiting on the user) can't hold blocking issues. */
export function pendingDeliveries(v: Pick<Variant, "channels" | "deliveries" | "status" | "scheduledAt">): boolean {
  if (!v.channels.length) return v.status === "scheduled";
  return v.channels.some((id) => PENDING.has(channelRowStatus(v, id)));
}

async function draftIssues(deps: McpToolDeps, variant: Variant, body: string): Promise<Issue[]> {
  const media = await deps.composer.media.inspect(variant);
  return deps.composer.check(variant, { body, media });
}

export function registerWriteTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const idem = new IdempotencyCache(() => deps.now());
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;
  const exists = (o: { ok: boolean; data?: Record<string, unknown> }) => !o.ok || !!deps.app.vault.getFileByPath(String(o.data?.path));

  registry.add(
    defineTool({
      name: "create_campaign",
      title: "Create a campaign",
      description:
        "Creates a campaign note (Social/<Title>/<Title>.md) holding the brief and the variants table. anchor_date is the event or launch date the timeline counts from. Pass idempotency_key so a retry never creates a second note.",
      input: z
        .object({
          title: z.string().trim().min(1).max(120),
          anchor_date: zWhen.optional(),
          link: zHttpUrl.optional().describe("The canonical link of the campaign"),
          brief: z.string().max(20_000).optional().describe("Goal, audience, key facts, call to action"),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "create_campaign",
          a.idempotency_key,
          async () => {
            const file = await deps.factory.createCampaign({ title: a.title, anchorDate: a.anchor_date, link: a.link, brief: a.brief });
            await untilIndexed(deps.index, () => !!deps.index.getCampaign(file.path));
            claudeNotice(deps, `Claude created the campaign ${a.title}.`, file.path);
            return ok({ path: file.path });
          },
          exists,
        ),
    }),
  );

  registry.add(
    defineTool({
      name: "create_variant",
      title: "Create a post",
      description:
        "Creates one platform variant as a draft: in a campaign (campaign = its note path) or standalone (title required). The text is checked first; on a blocking issue nothing is written unless force_draft. scheduled_at only proposes a time: call schedule to make it go out. Pass idempotency_key so a retry never creates a second note.",
      input: z
        .object({
          platform: z.enum(PLATFORMS),
          campaign: zPath.optional().describe("Path of the campaign note; leave out for a standalone post"),
          title: z.string().trim().min(1).max(300).optional().describe("Required for standalone posts, Hacker News, Reddit, Indie Hackers and WordPress"),
          channels: zChannelsArg.optional(),
          body: zBody.optional(),
          url: zHttpUrl.optional().describe("Link submissions (Hacker News, Reddit) and link cards"),
          media: zMedia.optional(),
          mode: z.enum(POST_MODES).optional().describe("auto posts by API where possible; assisted always reminds the user to post"),
          scheduled_at: zWhen.optional().describe("A proposed time; the post stays a draft until schedule is called"),
          reminders: zMinutesList.optional().describe("Minutes before the post, e.g. [60, 10]"),
          wordpress: zWordPress.optional(),
          force_draft: z.boolean().optional(),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "create_variant",
          a.idempotency_key,
          async () => {
            if (a.wordpress && a.platform !== "wordpress") return fail("wordpress fields are only for platform wordpress.");
            const campaign = a.campaign ? deps.index.getCampaign(normalizePathArg(a.campaign)) : undefined;
            if (a.campaign && !campaign) return fail(`No campaign note at "${a.campaign}". Use list_campaigns to find the path.`);
            const title = a.title?.trim() || undefined;
            if (!campaign && !title) return fail("A post outside a campaign needs a title.");
            const resolved = resolveChannels(deps, a.channels ?? [], a.platform);
            if (blocking(resolved.issues)) return fail("Unknown or wrong channels, so nothing was written.", resolved.issues);
            const variant: Variant = {
              path: campaign?.path ?? `${deps.settings().rootFolder}/Posts/${title}.md`,
              platform: a.platform,
              channels: resolved.channels.map((c) => c.id),
              mode: a.mode ?? "auto",
              status: "draft",
              media: a.media ?? [],
              deliveries: {},
              ...(title ? { title } : {}),
              ...(a.url ? { url: a.url } : {}),
              ...(a.scheduled_at !== undefined ? { scheduledAt: a.scheduled_at } : {}),
              ...(a.reminders ? { reminders: a.reminders } : {}),
              ...(a.platform === "wordpress" ? { wordpress: mergeWordPress(undefined, a.wordpress) } : {}),
            };
            const body = a.body ?? "";
            const issues = await draftIssues(deps, variant, body);
            if (blocking(issues) && !a.force_draft) return fail(BLOCKED, issues);
            const file = await deps.factory.createVariant({ platform: a.platform, campaign: campaign?.file, title, channels: variant.channels, body, scheduledAt: a.scheduled_at });
            const patch: VariantPatch = {};
            if (a.url) patch.url = a.url;
            if (a.media?.length) patch.media = a.media;
            if (a.reminders) patch.reminders = a.reminders;
            if (a.mode) patch.mode = a.mode;
            if (Object.keys(patch).length) await deps.writer.patchVariant(file, patch);
            if (a.wordpress) await deps.writer.setFields(file, wordpressFields(a.wordpress));
            await untilIndexed(deps.index, () => !!deps.index.getVariant(file.path));
            claudeNotice(deps, `Claude created ${file.basename}.`, file.path);
            return ok({ path: file.path, status: "draft", issues });
          },
          exists,
        ),
    }),
  );

  registry.add(
    defineTool({
      name: "update_variant",
      title: "Update a post",
      description:
        "Changes a post: text (body replaces the whole body), title, link, channels (the complete new list), mode, reminders, stagger, media, WordPress fields. Checked first; nothing is written on a blocking issue unless force_draft, which is refused for a scheduled post. Channels already published, handed over or waiting for the user stay. Edits don't change posts that are already live: use push_update for those.",
      input: z
        .object({
          path: zPath,
          title: z.union([z.string().trim().min(1).max(300), z.null()]).optional().describe("null removes it"),
          url: z.union([zHttpUrl, z.null()]).optional().describe("null removes it"),
          body: zBody.optional(),
          channels: zChannelsArg.optional(),
          mode: z.enum(POST_MODES).optional(),
          reminders: zMinutesList.optional(),
          stagger_minutes: z.number().int().min(0).max(1440).optional(),
          media: zMedia.optional(),
          wordpress: zWordPress.optional(),
          force_draft: z.boolean().optional(),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        if (a.wordpress && v.platform !== "wordpress") return fail("wordpress fields are only for platform wordpress.");
        if (v.channels.some((id) => v.deliveries[id]?.status === "publishing")) return fail("This post is being published right now. Try again in a minute.");
        let resolved: Channel[] | undefined;
        if (a.channels) {
          const r = resolveChannels(deps, a.channels, v.platform);
          if (blocking(r.issues)) return fail("Unknown or wrong channels, so nothing was written.", r.issues);
          resolved = r.channels;
        }
        const fields: Omit<VariantPatch, "deliveries" | "channels"> = {};
        if (a.title !== undefined) fields.title = a.title ?? undefined;
        if (a.url !== undefined) fields.url = a.url ?? undefined;
        if (a.mode) fields.mode = a.mode;
        if (a.reminders) fields.reminders = a.reminders;
        if (a.stagger_minutes !== undefined) fields.staggerMinutes = a.stagger_minutes;
        if (a.media) fields.media = a.media;
        const content = await deps.composer.content.load(v);
        const draft: Variant = {
          ...v,
          ...fields,
          ...(resolved ? { channels: resolved.map((c) => c.id) } : {}),
          ...(a.wordpress ? { wordpress: mergeWordPress(v.wordpress, a.wordpress) } : {}),
        };
        const nextBody = a.body ?? content.body;
        const issues = await draftIssues(deps, draft, nextBody);
        if (blocking(issues)) {
          if (!a.force_draft) return fail(BLOCKED, issues);
          if (pendingDeliveries(v)) return fail("This post is scheduled, so it can't be saved with blocking issues. Fix them, or call unschedule first.", issues);
        }
        const live = v.channels.filter((id) => LIVE.has(v.deliveries[id]?.status ?? ""));
        if (live.length) {
          issues.push({
            level: "warning",
            field: "deliveries",
            code: "already-live",
            message: `Already live on ${live.map(nameOf).join(", ")}. This edit doesn't change those posts; use push_update to change them there.`,
          });
        }
        const result = await deps.planner.write(v.file, (fresh) => {
          if (fresh.channels.some((id) => fresh.deliveries[id]?.status === "publishing")) return { refuse: "This post is being published right now. Try again in a minute." };
          if (!resolved) return { fields };
          const plan = planSetChannels(fresh, resolved, nameOf);
          if ("refuse" in plan) return plan;
          return { fields: { ...fields, ...plan.fields }, ...(plan.deliveries ? { deliveries: plan.deliveries } : {}) };
        });
        if (!result.ok) return fail(result.reason, issues);
        if (a.wordpress) await deps.writer.setFields(v.file, wordpressFields(a.wordpress));
        const bodyChanged = a.body !== undefined && a.body !== content.body;
        if (bodyChanged) await deps.writer.editBody(v.file, () => a.body as string);
        const changed = result.record.fields.length + result.record.deliveries.length > 0 || !!a.wordpress || bodyChanged;
        if (changed) {
          await untilIndexed(deps.index, () => deps.index.getVariant(v.path) !== v);
          claudeNotice(deps, `Claude updated ${v.displayTitle}.`, v.path);
        }
        return ok({ path: v.path, changed, issues });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "fork_variant",
      title: "Fork a channel into its own post",
      description:
        "Moves one channel of a post into a new note with its own copy of the text (for example a company page that needs different wording). The channel is removed from the original.",
      input: z.object({ path: zPath, channel: z.string().trim().min(1).max(80) }).strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        if (!v.channels.includes(a.channel)) return fail(`${a.channel} is not a channel of this post.`);
        try {
          const file = await deps.factory.forkVariant(v.file, a.channel, nameOf(a.channel));
          await untilIndexed(deps.index, () => !!deps.index.getVariant(file.path));
          claudeNotice(deps, `Claude forked ${nameOf(a.channel)} into its own note.`, file.path);
          return ok({ path: file.path, original: v.path });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    }),
  );

  registry.add(
    defineTool({
      name: "validate",
      title: "Validate a post",
      description:
        "Runs the plugin's checks without writing: either an existing note (path) or a draft you are about to write (draft). Returns issues (errors block scheduling), blocking, and the length counters.",
      input: z
        .object({
          path: zPath.optional(),
          draft: z
            .object({
              platform: z.enum(PLATFORMS),
              channels: zChannelsArg.optional(),
              title: z.string().trim().max(300).optional(),
              url: zHttpUrl.optional(),
              body: zBody,
              media: zMedia.optional(),
              wordpress: zWordPress.optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a) => {
        if (!a.path === !a.draft) return fail("Pass either path or draft.");
        if (a.path) {
          const v = findPost(deps, a.path);
          if (!v) return fail(noPost(a.path));
          const content = await deps.composer.content.load(v);
          const issues = deps.composer.check(v, content);
          return ok({ path: v.path, issues, blocking: blocking(issues), counters: deps.composer.counters(v, content) });
        }
        const d = a.draft!;
        const resolved = resolveChannels(deps, d.channels ?? [], d.platform);
        const variant: Variant = {
          path: `${deps.settings().rootFolder}/Posts/draft.md`,
          platform: d.platform,
          channels: resolved.channels.map((c) => c.id),
          mode: "auto",
          status: "draft",
          media: d.media ?? [],
          deliveries: {},
          ...(d.title ? { title: d.title } : {}),
          ...(d.url ? { url: d.url } : {}),
          ...(d.platform === "wordpress" ? { wordpress: mergeWordPress(undefined, d.wordpress) } : {}),
        };
        const media = await deps.composer.media.inspect(variant);
        const issues = [...resolved.issues, ...deps.composer.check(variant, { body: d.body, media })];
        return ok({ issues, blocking: blocking(issues), counters: deps.composer.counters(variant, { body: d.body, media }) });
      },
    }),
  );
}
```
Wire it: in `src/mcp/index.ts` add `import { registerWriteTools } from "./tools/write";` and `registerWriteTools(registry, deps);` after the read tools.


- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/model test/composer test/mcp && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/mcp src/model/writer.ts src/model/factory.ts src/composer/channels.ts test/mcp test/model test/composer
git commit -m "feat(mcp): create, update, fork and validate tools through the factory and the safe writer (#75)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Schedule and unschedule tools, and the round trip (#75, part 2)

**Files:**
- Create: `src/mcp/tools/schedule.ts`, `test/mcp/schedule.test.ts`
- Modify: `src/mcp/index.ts`

**Interfaces:**
- Consumes: `planComposerSchedule`, `scheduleNeeds`, `reminderDefaults` (`src/composer/schedule.ts`); `deliveryChanges` (`src/planner/changes.ts`); `unscheduleBlocked`, `unscheduleDeliveries`, `UNSCHEDULE_BLOCKED` (`src/planner/board.ts`); `PlannerActions.write`; `ComposerActions.check/content/channelsOf`; `channelRows`, `iso` (Task 4); `findPost`, `noPost`, `zPath`, `zWhen`, `untilIndexed`, `claudeNotice` (Task 4).
- Produces: `registerScheduleTools(registry, deps)` with
  - `schedule { path, at, reminders?, move_awaiting? }` → `{ ok, path, scheduled_at, reminders, channels, issues }`; refuses (nothing written) a past time (`code: "past-time"`), a post without channels, blocking issues (an unreadable delivery entry is one: `unreadable-delivery`), a handed-over channel, and channels awaiting the user unless `move_awaiting: true` (then `needs_confirmation: "move_awaiting"` is returned).
  - `unschedule { path, to?: "draft" | "ready" }` → refuses when a channel was handed over, published or is awaiting the user (`UNSCHEDULE_BLOCKED`).

- [ ] **Step 1: Write the failing tests**

`test/mcp/schedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { expandRows, rowsBetween } from "../../src/index/queries";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";
const LI = "Social/Event X/Event X – LinkedIn.md";
const FRI_9 = "2026-10-09T09:00:00+02:00";

async function fm(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("schedule (#75)", () => {
  it("round trip: create → validate → schedule shows up in the calendar (#75 acceptance)", async () => {
    const c = await mcpCtx();
    const created = await c.call("create_variant", { platform: "bluesky", campaign: EX, channels: ["bs/you"], body: "Event X is back on the 12th. One evening, 80 makers.", idempotency_key: "round-trip-0001" });
    expect(created.ok).toBe(true);
    expect(await c.call("validate", { path: created.path })).toMatchObject({ ok: true, blocking: false });
    const r = await c.call("schedule", { path: created.path, at: FRI_9, reminders: [60, 10] });
    expect(r).toMatchObject({ ok: true, path: created.path, scheduled_at: FRI_9, reminders: [60, 10] });
    expect(r.channels).toEqual([{ id: "bs/you", name: "@you.bsky.social", status: "scheduled", at: FRI_9 }]);
    const rows = expandRows(c.index.variants(), 15);
    const week = rowsBetween(rows, Date.parse("2026-10-05T00:00:00+02:00"), Date.parse("2026-10-12T00:00:00+02:00"));
    expect(week.find((row) => row.variant.path === created.path)).toMatchObject({ channelId: "bs/you", status: "scheduled", at: Date.parse(FRI_9) });
    expect((await c.call("get_post", { path: created.path })).status).toBe("scheduled");
  });

  it("is idempotent: scheduling again at the same time changes nothing (review focus 2)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    await c.call("schedule", { path: X, at: FRI_9 });
    const once = await c.app.vault.read(c.app.vault.getFileByPath(X)!);
    const again = await c.call("schedule", { path: X, at: FRI_9 });
    expect(again.ok).toBe(true);
    expect(await c.app.vault.read(c.app.vault.getFileByPath(X)!)).toBe(once);
  });

  it("refuses a time in the past and writes nothing", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const before = await fm(c, X);
    const r = await c.call("schedule", { path: X, at: "2026-10-01T09:00:00+02:00" });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ field: "at", code: "past-time" })]);
    expect(await fm(c, X)).toEqual(before);
  });

  it("refuses blocking issues and posts handed over to the platform", async () => {
    const c = await mcpCtx();
    const ig = await c.call("create_variant", { platform: "instagram", campaign: EX, channels: ["ig/acmestudio"], body: "No image yet", force_draft: true });
    const blocked = await c.call("schedule", { path: ig.path, at: FRI_9 });
    expect(blocked.ok).toBe(false);
    expect(blocked.issues.some((i: R) => i.level === "error")).toBe(true);
    expect(c.index.getVariant(ig.path)!.status).toBe("draft");
    const wp = await c.call("schedule", { path: "Social/Event X/Event X – WordPress.md", at: FRI_9 });
    expect(wp.error).toContain("handed over");
  });

  it("asks before moving channels that wait for the user (M2b P2)", async () => {
    const c = await mcpCtx();
    const first = await c.call("schedule", { path: LI, at: FRI_9 });
    expect(first).toMatchObject({ ok: false, needs_confirmation: "move_awaiting" });
    const confirmed = await c.call("schedule", { path: LI, at: FRI_9, move_awaiting: true });
    expect(confirmed.ok).toBe(true);
    const d = (await fm(c, LI)).deliveries as Record<string, Record<string, unknown>>;
    expect(d["li/me"]).toMatchObject({ status: "published" });
    expect(d["li/acme-studio"]).toMatchObject({ status: "awaiting_you" });
    expect(d["li/acme-studio"]!.at).toBeUndefined();
    expect(d["li/maker-lab"]).toEqual({ status: "scheduled" });
  });

  it("refuses a note with an unreadable entry and leaves it untouched (frozen)", async () => {
    const c = await mcpCtx({
      notes: [
        {
          path: "Social/Posts/Frozen.md",
          frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me", "li/osmm"], status: "draft", deliveries: { "li/me": { status: "publishd" } } },
          body: "Hello makers",
        },
      ],
    });
    const r = await c.call("schedule", { path: "Social/Posts/Frozen.md", at: FRI_9 });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.code)).toContain("unreadable-delivery");
    expect((await fm(c, "Social/Posts/Frozen.md")).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });
});

describe("unschedule", () => {
  it("moves a scheduled post back to draft and refuses one that was handed over", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const r = await c.call("unschedule", { path: X });
    expect(r).toMatchObject({ ok: true, status: "draft" });
    expect(((await fm(c, X)).deliveries as Record<string, unknown>)["x/you"]).toEqual({ status: "draft" });
    expect((await c.call("unschedule", { path: "Social/Event X/Event X – WordPress.md" })).error).toBe(
      "Some channels were already handed over or published. Unschedule the remaining ones from the post itself.",
    );
  });
});
```

Note: `composer.check` reports an unreadable entry as a blocking error (`unreadable-delivery`), so `schedule` refuses a note with a frozen entry and the entry stays untouched; `planComposerSchedule`'s own skip remains as a second guard.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/schedule.test.ts`
Expected: FAIL — `Unknown tool: schedule`.

- [ ] **Step 3: Write the tools**

`src/mcp/tools/schedule.ts`:
```ts
import { z } from "zod";
import { planComposerSchedule, reminderDefaults, scheduleNeeds } from "../../composer/schedule";
import { zMinutesList } from "../../model/schemas";
import type { Delivery } from "../../model/types";
import { UNSCHEDULE_BLOCKED, unscheduleBlocked, unscheduleDeliveries } from "../../planner/board";
import { deliveryChanges } from "../../planner/changes";
import { blocking } from "../../platforms/checks";
import { formatShortDate, formatTime } from "../../ui/format";
import { claudeNotice, findPost, noPost, untilIndexed, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { channelRows, iso } from "../present";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const HANDED_OVER = "Some channels were already handed over to the platform. Change the time in Obsidian, or ask the user; the platform keeps the old time until an update is pushed.";
const AWAITING =
  "Some channels are waiting for the user to post them by hand. Ask the user whether to move them too, then call schedule again with move_awaiting: true.";

export function registerScheduleTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;
  const stagger = () => deps.settings().defaultStaggerMinutes;

  registry.add(
    defineTool({
      name: "schedule",
      title: "Schedule a post",
      description:
        "Makes a post go out at `at` on all its channels (staggered by the post's stagger). The plugin checks it first and refuses blocking issues, times in the past and channels already handed over to the platform. API channels then post by themselves on the publisher device; the others remind the user. Only call this after the user agreed to the plan.",
      input: z
        .object({
          path: zPath,
          at: zWhen.describe("When the first channel posts, e.g. 2026-10-08T17:30:00+02:00"),
          reminders: zMinutesList.optional().describe("Minutes before, e.g. [60, 10]; defaults to the channel's or the plugin's"),
          move_awaiting: z.boolean().optional().describe("true only after the user agreed to move channels that wait for them"),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const now = deps.now();
        if (a.at <= now) {
          const message = "That time has passed. Pick a future time (find_free_slots can help).";
          return fail(message, [{ level: "error", field: "at", code: "past-time", message }]);
        }
        if (!v.channels.length) return fail("Pick at least one channel first (update_variant with channels).");
        const issues = deps.composer.check(v, await deps.composer.content.load(v));
        if (blocking(issues)) return fail("Blocking issues, so the post was not scheduled.", issues);
        const needs = scheduleNeeds(v, a.at, now);
        if (needs.handedOver) return fail(HANDED_OVER);
        if (needs.awaitingYou && !a.move_awaiting) return fail(AWAITING, undefined, { needs_confirmation: "move_awaiting" });
        const reminders = a.reminders ?? reminderDefaults(v, deps.composer.channelsOf(v), deps.settings());
        const result = await deps.planner.write(v.file, (fresh) => {
          const again = scheduleNeeds(fresh, a.at, now);
          if (again.handedOver) return { refuse: HANDED_OVER };
          if (again.awaitingYou && !a.move_awaiting) return { refuse: AWAITING };
          const plan = planComposerSchedule(fresh, { at: a.at, reminders }, stagger());
          if ("refuse" in plan) return plan;
          return { fields: plan.fields, deliveries: deliveryChanges(fresh, plan.deliveries as Record<string, Delivery>) };
        });
        if (!result.ok) return fail(result.reason);
        const changed = result.record.fields.length + result.record.deliveries.length > 0;
        // Wait for the reindex so the next read tool sees the write; nothing to wait for when nothing changed.
        if (changed) await untilIndexed(deps.index, () => deps.index.getVariant(v.path) !== v);
        const fresh = deps.index.getVariant(v.path) ?? v;
        if (changed) claudeNotice(deps, `Claude scheduled ${v.displayTitle} for ${formatShortDate(a.at)} ${formatTime(a.at)}.`, v.path);
        return ok({ path: v.path, scheduled_at: iso(a.at), reminders, channels: channelRows(fresh, stagger(), nameOf), issues });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "unschedule",
      title: "Unschedule a post",
      description: "Moves a scheduled post back to draft (or ready). Refused when a channel was already handed over, published or is waiting for the user. The proposed time is kept.",
      input: z.object({ path: zPath, to: z.enum(["draft", "ready"]).default("draft") }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const result = await deps.planner.write(v.file, (fresh) => {
          if (unscheduleBlocked(fresh)) return { refuse: UNSCHEDULE_BLOCKED };
          return { fields: { status: a.to }, deliveries: deliveryChanges(fresh, unscheduleDeliveries(fresh, a.to)) };
        });
        if (!result.ok) return fail(result.reason);
        await untilIndexed(deps.index, () => deps.index.getVariant(v.path)?.status === a.to);
        claudeNotice(deps, `Claude unscheduled ${v.displayTitle}.`, v.path);
        return ok({ path: v.path, status: a.to });
      },
    }),
  );
}
```
Wire it: in `src/mcp/index.ts` add `import { registerScheduleTools } from "./tools/schedule";` and `registerScheduleTools(registry, deps);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp test/mcp
git commit -m "feat(mcp): schedule and unschedule tools with the composer's rules (#75)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: `find_free_slots` (#76)

**Files:**
- Create: `src/mcp/slots.ts`, `src/mcp/tools/slots.ts`, `test/mcp/slots.test.ts`
- Modify: `src/mcp/index.ts`

**Interfaces:**
- Consumes: `PostRow` (`src/index/queries.ts`); `startOfLocalDay`, `addLocalDays`, `MINUTE`, `DAY` (`src/model/dates.ts`); `zTimeOfDay` (`src/model/schemas.ts`); `PlannerActions.rows()`; `ChannelRegistry.expand/get`; `iso`, `zWhen`, `zChannelsArg` (Task 4).
- Produces:
  - `interface SlotWindow { days?: readonly number[]; start: string; end: string }` (days: 0 = Sunday … 6 = Saturday; times `HH:mm`, local).
  - `interface SlotQuery { from: number; to: number; now: number; minSpacingMinutes: number; stepMinutes: number; perChannel: number; windows?: readonly SlotWindow[]; preferredTime?: string }`.
  - `findFreeSlots(busy: readonly number[], q: SlotQuery): FreeSlot[]` — pure and deterministic: candidates every `stepMinutes` inside the windows (default 09:00–18:00 every day) within `[from, to)` and after `now`, at least `minSpacingMinutes` from every busy time; scored `100 − |minutes from the preferred time| / 6` (preferred = the channel's usual time when inside the window, else the window start); ranked by score, then time; picked greedily so picks are also `minSpacingMinutes` apart. `FreeSlot = { at: number; score: number; nearestMinutes: number | null }`.
  - `busyTimes(rows, channelId): number[]` — every row of that channel with a time, except `skipped` (drafts' proposed times count, so Claude doesn't stack its own drafts).
  - `DEFAULT_WINDOW = { start: "09:00", end: "18:00" }`, `MAX_RANGE_DAYS = 62`.
  - Tool `find_free_slots { channels, from?, to?, min_spacing_minutes = 180, preferred_windows?, step_minutes = 30, per_channel = 5 }` → `{ from, to, channels: [{ channel_id, name, platform, slots: [{ at, score, nearest_post_minutes }] }], unknown_channels }`.

- [ ] **Step 1: Write the failing tests**

`test/mcp/slots.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/model/dates";
import { findFreeSlots, type SlotQuery } from "../../src/mcp/slots";
import { mcpCtx, type R } from "./helpers";

/** Local (Berlin) time on day `d` after Monday 12 Oct 2026. */
const at = (d: number, h: number, m = 0) => new Date(2026, 9, 12 + d, h, m).getTime();
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ from: at(0, 0), to: at(1, 0), now: at(0, 0) - 1, minSpacingMinutes: 120, stepMinutes: 60, perChannel: 3, ...over });
const times = (slots: Array<{ at: number }>) => slots.map((s) => formatDateTime(s.at).slice(0, 16));

describe("findFreeSlots (#76)", () => {
  it("prefers the start of the window and keeps picks apart", () => {
    const slots = findFreeSlots([], q());
    expect(times(slots)).toEqual(["2026-10-12T09:00", "2026-10-12T11:00", "2026-10-12T13:00"]);
    expect(slots.map((s) => [s.score, s.nearestMinutes])).toEqual([[100, null], [80, null], [60, null]]);
  });

  it("avoids existing posts on the channel by the minimum spacing", () => {
    const slots = findFreeSlots([at(0, 10)], q());
    expect(times(slots)).toEqual(["2026-10-12T12:00", "2026-10-12T14:00", "2026-10-12T16:00"]);
    expect(slots.map((s) => s.nearestMinutes)).toEqual([120, 240, 360]);
  });

  it("ranks by closeness to the channel's usual time", () => {
    const slots = findFreeSlots([], q({ preferredTime: "17:30", stepMinutes: 30, perChannel: 2 }));
    expect(times(slots)).toEqual(["2026-10-12T17:30", "2026-10-12T15:30"]);
    expect(slots.map((s) => s.score)).toEqual([100, 80]);
  });

  it("keeps to the preferred weekdays", () => {
    const slots = findFreeSlots([], q({ to: at(7, 0), windows: [{ days: [6, 0], start: "10:00", end: "10:00" }], perChannel: 5 }));
    expect(times(slots)).toEqual(["2026-10-17T10:00", "2026-10-18T10:00"]);
  });

  it("keeps the wall-clock time across the end of summer time", () => {
    const slots = findFreeSlots([], q({ from: at(12, 0), to: at(14, 0), windows: [{ start: "09:00", end: "09:00" }], perChannel: 5 }));
    expect(slots.map((s) => formatDateTime(s.at))).toEqual(["2026-10-24T09:00:00+02:00", "2026-10-25T09:00:00+01:00"]);
  });

  it("never proposes the past and is deterministic", () => {
    const later = q({ now: at(0, 12) });
    expect(findFreeSlots([], later).every((s) => s.at > at(0, 12))).toBe(true);
    expect(findFreeSlots([at(0, 15)], later)).toEqual(findFreeSlots([at(0, 15)], later));
  });
});

describe("find_free_slots tool", () => {
  it("proposes spaced slots per channel, expanding groups and reporting unknown ids", async () => {
    const c = await mcpCtx();
    const r = await c.call("find_free_slots", {
      channels: ["li/me", "group:all-linkedin-pages", "li/nope"],
      from: "2026-10-08T12:00:00+02:00",
      to: "2026-10-10T00:00:00+02:00",
    });
    expect(r.ok).toBe(true);
    expect(r.unknown_channels).toEqual(["li/nope"]);
    expect(r.channels.map((ch: R) => ch.channel_id)).toEqual(["li/me", "li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    const acme = r.channels.find((ch: R) => ch.channel_id === "li/acme-studio");
    const awaiting = Date.parse("2026-10-08T17:45:00+02:00");
    expect(acme.slots.length).toBeGreaterThan(0);
    for (const s of acme.slots) expect(Math.abs(Date.parse(s.at) - awaiting)).toBeGreaterThanOrEqual(180 * 60_000);
    const all = r.channels[0].slots.map((s: R) => Date.parse(s.at)).sort((a: number, b: number) => a - b);
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(180 * 60_000);
  });

  it("refuses ranges that are backwards or too long", async () => {
    const c = await mcpCtx();
    expect((await c.call("find_free_slots", { channels: ["li/me"], from: "2026-10-10T00:00:00+02:00", to: "2026-10-09T00:00:00+02:00" })).error).toBe("to must be after from.");
    expect((await c.call("find_free_slots", { channels: ["li/me"], from: "2026-10-10T00:00:00+02:00", to: "2027-01-10T00:00:00+01:00" })).error).toBe("Ask for at most 62 days at a time.");
    expect((await c.call("find_free_slots", { channels: ["li/me"], preferred_windows: [{ start: "18:00", end: "09:00" }] })).error).toBe("Each window must start before it ends.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/slots.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/slots'`.

- [ ] **Step 3: Write the slot finder**

`src/mcp/slots.ts`:
```ts
import type { PostRow } from "../index/queries";
import { addLocalDays, MINUTE, startOfLocalDay } from "../model/dates";

export interface SlotWindow {
  /** 0 = Sunday … 6 = Saturday; every day when left out. */
  days?: readonly number[];
  /** Local HH:mm, inclusive. */
  start: string;
  end: string;
}

export interface SlotQuery {
  from: number;
  to: number;
  now: number;
  minSpacingMinutes: number;
  stepMinutes: number;
  perChannel: number;
  windows?: readonly SlotWindow[];
  /** The channel's usual posting time (HH:mm); slots closer to it rank higher. */
  preferredTime?: string;
}

export interface FreeSlot {
  at: number;
  score: number;
  /** Minutes to the nearest existing post on the channel; null when it has none. */
  nearestMinutes: number | null;
}

export const DEFAULT_WINDOW: SlotWindow = { start: "09:00", end: "18:00" };
export const MAX_RANGE_DAYS = 62;

export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Times the channel is already taken: every row with a time except skipped ones (drafts' proposed times count). */
export function busyTimes(rows: readonly PostRow[], channelId: string): number[] {
  return rows
    .filter((r) => r.channelId === channelId && r.at !== undefined && r.status !== "skipped")
    .map((r) => r.at as number)
    .sort((a, b) => a - b);
}

function nearest(busy: readonly number[], at: number): number | null {
  if (!busy.length) return null;
  return Math.round(Math.min(...busy.map((b) => Math.abs(b - at))) / MINUTE);
}

/** Ranked free slots for one channel (#76). Pure: the same input always gives the same output. */
export function findFreeSlots(busy: readonly number[], q: SlotQuery): FreeSlot[] {
  const windows = q.windows?.length ? q.windows : [DEFAULT_WINDOW];
  const spacing = q.minSpacingMinutes * MINUTE;
  const scores = new Map<number, number>();
  for (let day = startOfLocalDay(q.from); day < q.to; day = addLocalDays(day, 1)) {
    const d = new Date(day);
    for (const w of windows) {
      if (w.days && !w.days.includes(d.getDay())) continue;
      const start = minutesOfDay(w.start);
      const end = minutesOfDay(w.end);
      const wanted = q.preferredTime ? minutesOfDay(q.preferredTime) : -1;
      const preferred = wanted >= start && wanted <= end ? wanted : start;
      for (let m = start; m <= end; m += q.stepMinutes) {
        // Built from the calendar date, so 09:00 stays 09:00 across a DST change.
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m).getTime();
        if (at < q.from || at >= q.to || at <= q.now) continue;
        if (busy.some((b) => Math.abs(b - at) < spacing)) continue;
        const score = Math.max(0, 100 - Math.round(Math.abs(m - preferred) / 6));
        if ((scores.get(at) ?? -1) < score) scores.set(at, score);
      }
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const picked: Array<[number, number]> = [];
  for (const candidate of ranked) {
    if (picked.length >= q.perChannel) break;
    if (picked.every(([t]) => Math.abs(t - candidate[0]) >= spacing)) picked.push(candidate);
  }
  return picked.map(([t, score]) => ({ at: t, score, nearestMinutes: nearest(busy, t) }));
}
```

- [ ] **Step 4: Write the tool**

`src/mcp/tools/slots.ts`:
```ts
import { z } from "zod";
import { addLocalDays, DAY } from "../../model/dates";
import { zTimeOfDay } from "../../model/schemas";
import { zChannelsArg, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { iso } from "../present";
import { busyTimes, findFreeSlots, MAX_RANGE_DAYS, minutesOfDay } from "../slots";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

export function registerSlotTools(registry: ToolRegistry, deps: McpToolDeps): void {
  registry.add(
    defineTool({
      name: "find_free_slots",
      title: "Find free slots",
      description:
        "Proposes posting times per channel that keep min_spacing_minutes away from everything already planned on that channel (drafts included), inside the preferred windows (default 09:00–18:00 local), closest to the channel's usual time first. Deterministic. Use it to fill a campaign timeline, then confirm the plan with the user before schedule.",
      input: z
        .object({
          channels: zChannelsArg,
          from: zWhen.optional().describe("Default: now"),
          to: zWhen.optional().describe("Default: 14 days after from; at most 62 days"),
          min_spacing_minutes: z.number().int().min(0).max(10_080).default(180),
          preferred_windows: z
            .array(
              z
                .object({
                  days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe("0 = Sunday … 6 = Saturday"),
                  start: zTimeOfDay,
                  end: zTimeOfDay,
                })
                .strict(),
            )
            .max(7)
            .optional(),
          step_minutes: z.number().int().min(5).max(240).default(30),
          per_channel: z.number().int().min(1).max(20).default(5),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a) => {
        const now = deps.now();
        const from = a.from ?? now;
        const to = a.to ?? addLocalDays(from, 14);
        if (to <= from) return fail("to must be after from.");
        if (to - from > MAX_RANGE_DAYS * DAY) return fail(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
        if (a.preferred_windows?.some((w) => minutesOfDay(w.start) > minutesOfDay(w.end))) return fail("Each window must start before it ends.");
        const ids: string[] = [];
        const unknown: string[] = [];
        for (const raw of a.channels) {
          const expanded = deps.channels.expand([raw]);
          if (!expanded.length) unknown.push(raw);
          for (const id of expanded) if (!ids.includes(id)) ids.push(id);
        }
        const rows = deps.planner.rows();
        const channels = ids.map((id) => {
          const channel = deps.channels.get(id)!;
          const slots = findFreeSlots(busyTimes(rows, id), {
            from,
            to,
            now,
            minSpacingMinutes: a.min_spacing_minutes,
            stepMinutes: a.step_minutes,
            perChannel: a.per_channel,
            windows: a.preferred_windows,
            preferredTime: channel.defaultTime,
          });
          return { channel_id: id, name: channel.name, platform: channel.platform, slots: slots.map((s) => ({ at: iso(s.at), score: s.score, nearest_post_minutes: s.nearestMinutes })) };
        });
        return ok({ from: iso(from), to: iso(to), channels, unknown_channels: unknown });
      },
    }),
  );
}
```
Wire it: in `src/mcp/index.ts` add `import { registerSlotTools } from "./tools/slots";` and `registerSlotTools(registry, deps);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mcp && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp test/mcp
git commit -m "feat(mcp): find_free_slots proposes spaced posting times per channel (#76)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Publish tools with approval in Obsidian (#77)

**Files:**
- Create: `src/mcp/approval.ts`, `src/mcp/ApprovalModal.ts`, `src/mcp/tools/publish.ts`, `test/mcp/approval.test.ts`, `test/mcp/publish.test.ts`
- Modify: `src/settings/settings.ts` (schema 4, `publishWithoutAsking`), `src/publish/actions.ts`, `src/publish/log.ts`, `src/publish/vaultLog.ts`, `src/mcp/deps.ts`, `src/mcp/index.ts`, `src/main.ts`, `src/styles/composer.css`, `test/mcp/helpers.ts`, `test/settings/settings.test.ts`

**Interfaces:**
- Consumes: `PublishActions` internals (`freshContent`, `runApiInBackground`, `openAssisted`, `context.publisher`), `assistedQueue`, `effectiveMethod`, `ComposerActions.check`, `postItems`/`postText`, `platformDef`, `PublisherService.isPublisher()/state()`, `AttemptLog`; `findPost`, `noPost`, `clip`, `zPath` (Task 4).
- Produces:
  - Settings schema 4: `OsmmSettings.publishWithoutAsking: string[]` (channel ids; default `[]`; synced).
  - `AttemptEntry.result` gains `"updated"` (log label "updated on the platform").
  - `sendDigest(v: Variant, content: LoadedContent): string`; `interface SendPlan { path; queue: string[]; api: string[]; assisted: string[]; text: string; digest: string }`; `interface UpdatePlan { path; channels: string[]; text: string; digest: string }`; `type SendRefusal = { refuse: string; issues?: Issue[] }`.
  - `PublishActions.prepareSend(path, channelIds?)`, `sendApproved(plan): Promise<{ started: string[]; opened: string[] } | SendRefusal>`, `prepareUpdate(path, channelIds?)`, `updateApproved(plan): Promise<{ updated: string[]; failed: Array<{ id: string; error: string }> } | SendRefusal>`, `apiBlockedReason(): string | null`.
  - `interface ApprovalRequest { action: "publish" | "update"; title: string; path: string; platformLabel: string; channels: Array<{ id: string; name: string; how: string }>; text: string; note?: string }`; `type ApprovalAnswer = { approved: true; how: "asked" | "policy" } | { approved: false; reason: string }`.
  - `class ApprovalGate { constructor({ open(req, answer): { close(): void }; allowedWithoutAsking(channelId): boolean; timeoutMs? }); readonly waiting: boolean; request(req): Promise<ApprovalAnswer>; dispose(): void }`; `APPROVAL_TIMEOUT_MS = 120_000`; reasons `DENIED`, `TIMED_OUT`, `BUSY`, `CLOSED`.
  - `openApprovalModal(app, req, answer): { close(): void }`.
  - `McpToolDeps.approvals: ApprovalGate`; `OsmmPlugin.approvals`.
  - Tools `publish_now { path, channels?, note? }` and `push_update { path, channels?, note? }`.
  - Test helper `scriptedApprovals(answers, opts?)` → `{ gate, asked }`; `mcpCtx({ approvals? })`.

- [ ] **Step 1: Write the failing tests**

`test/settings/settings.test.ts`: change the three `toBe(3)` schema assertions to `toBe(4)`, and add:
```ts
  it("adds publishWithoutAsking in schema 4 and keeps only channel ids", () => {
    expect(migrateSettings({ schemaVersion: 3 }).publishWithoutAsking).toEqual([]);
    expect(migrateSettings({ schemaVersion: 4, publishWithoutAsking: ["tg/event-x", "nope", 3] }).publishWithoutAsking).toEqual(["tg/event-x"]);
  });
```

`test/mcp/approval.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { App, Modal } from "../fakes/obsidian";
import { ApprovalGate, BUSY, CLOSED, DENIED, TIMED_OUT, type ApprovalAnswer, type ApprovalRequest } from "../../src/mcp/approval";
import { openApprovalModal } from "../../src/mcp/ApprovalModal";

const REQ: ApprovalRequest = {
  action: "publish",
  title: "Doors open",
  path: "Social/Posts/Tg.md",
  platformLabel: "Telegram",
  channels: [{ id: "tg/event-x", name: "Event X channel", how: "posts through the API now" }],
  text: "Doors open at 18:00",
  note: "The user asked to post it now.",
};

describe("ApprovalGate", () => {
  it("skips the question only when every channel may publish without asking", async () => {
    let opened = 0;
    const gate = new ApprovalGate({ open: () => (opened++, { close: () => undefined }), allowedWithoutAsking: (id) => id === "tg/event-x", timeoutMs: 20 });
    expect(await gate.request(REQ)).toEqual({ approved: true, how: "policy" });
    const two = { ...REQ, channels: [...REQ.channels, { id: "li/me", name: "Me", how: "x" }] };
    expect(await gate.request(two)).toEqual({ approved: false, reason: TIMED_OUT });
    expect(opened).toBe(1);
  });

  it("denies when nobody answers, when a question is already open, and on unload (review focus 3, 4)", async () => {
    const closed: number[] = [];
    const gate = new ApprovalGate({ open: () => ({ close: () => void closed.push(1) }), allowedWithoutAsking: () => false, timeoutMs: 200 });
    const first = gate.request(REQ);
    expect(gate.waiting).toBe(true);
    expect(await gate.request(REQ)).toEqual({ approved: false, reason: BUSY });
    gate.dispose();
    expect(await first).toEqual({ approved: false, reason: CLOSED });
    expect(closed).toEqual([1]);
    expect(gate.waiting).toBe(false);
  });

  it("takes the first answer only, even when the view answers at once", async () => {
    const gate = new ApprovalGate({
      open: (_req, answer) => {
        answer({ approved: true, how: "asked" });
        answer({ approved: false, reason: DENIED });
        return { close: () => undefined };
      },
      allowedWithoutAsking: () => false,
    });
    expect(await gate.request(REQ)).toEqual({ approved: true, how: "asked" });
    expect(gate.waiting).toBe(false);
  });
});

describe("approval modal", () => {
  const buttons = (m: Modal) => [...m.contentEl.querySelectorAll("button")];

  it("shows what, where and when, and approves", () => {
    const answers: ApprovalAnswer[] = [];
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    const modal = Modal.opened.at(-1)!;
    expect(modal.titleEl.textContent).toBe("Claude wants to publish");
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("Doors open · Telegram · 1 channel · now");
    expect(text).toContain("Event X channel: posts through the API now");
    expect(text).toContain("Doors open at 18:00");
    expect(text).toContain("The user asked to post it now.");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    buttons(modal).find((b) => b.textContent === "Approve")!.click();
    expect(answers).toEqual([{ approved: true, how: "asked" }]);
    expect(modal.isOpen).toBe(false);
  });

  it("denies with the user's reason, and denies when closed without an answer", () => {
    const answers: ApprovalAnswer[] = [];
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    const modal = Modal.opened.at(-1)!;
    modal.contentEl.querySelector("textarea")!.value = "not today";
    buttons(modal).find((b) => b.textContent === "Deny")!.click();
    openApprovalModal(new App() as never, REQ, (a) => void answers.push(a));
    Modal.opened.at(-1)!.close();
    expect(answers).toEqual([
      { approved: false, reason: "The user said no in Obsidian: not today" },
      { approved: false, reason: DENIED },
    ]);
  });
});
```

`test/mcp/publish.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { Modal } from "../fakes/obsidian";
import { BUSY, TIMED_OUT } from "../../src/mcp/approval";
import type { OsmmSettings } from "../../src/settings/settings";
import { indexed, writeNote } from "../helpers";
import { mcpCtx, scriptedApprovals, type R } from "./helpers";

const TG = "Social/Posts/Tg.md";
const tgNote = (delivery: Record<string, unknown> = { status: "scheduled" }, body = "Doors open at 18:00") => ({
  path: TG,
  frontmatter: { type: "social-post", platform: "telegram", title: "Doors open", channels: ["tg/event-x"], status: "scheduled", scheduled_at: "2026-10-08T14:00:00+02:00", deliveries: { "tg/event-x": delivery } },
  body,
});

async function setup(answers: Parameters<typeof scriptedApprovals>[0] = [], opts: { timeoutMs?: number; note?: ReturnType<typeof tgNote>; publisher?: boolean } = {}) {
  // The policy is read from the test's synced settings, as the plugin reads OsmmSettings.publishWithoutAsking.
  let settings: (() => OsmmSettings) | null = null;
  const approvals = scriptedApprovals(answers, { timeoutMs: opts.timeoutMs, allowed: (id) => settings?.().publishWithoutAsking.includes(id) ?? false });
  const c = await mcpCtx({ notes: [opts.note ?? tgNote()], approvals: approvals.gate });
  settings = () => get(c.settings);
  const publish = vi.fn(async () => ({ remoteId: "42", url: "https://t.me/eventx/42" }));
  const update = vi.fn(async () => undefined);
  c.adapters.register({ platform: "telegram", publish, update });
  if (opts.publisher !== false) await c.publisher.claim();
  return { c, publish, update, asked: approvals.asked };
}

describe("publish_now (#77)", () => {
  it("sends nothing without an answer under the default policy (#77 acceptance)", async () => {
    const { c, publish, asked } = await setup([]);
    const r = await c.call("publish_now", { path: TG, note: "The user asked to post it now." });
    expect(r).toMatchObject({ ok: false, approved: false, error: TIMED_OUT });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "publish", title: "Doors open", text: "Doors open at 18:00", note: "The user asked to post it now." });
    expect(asked[0].channels).toEqual([{ id: "tg/event-x", name: "Event X channel", how: "posts through the API now" }]);
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(TG)!.deliveries["tg/event-x"]!.status).toBe("scheduled");
    expect(c.log.entries).toEqual([]);
  });

  it("returns the user's refusal", async () => {
    const { c, publish } = await setup([{ approved: false, reason: "The user said no in Obsidian: not today" }]);
    expect((await c.call("publish_now", { path: TG })).error).toBe("The user said no in Obsidian: not today");
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes once after the user approves", async () => {
    const { c, publish } = await setup([{ approved: true, how: "asked" }]);
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: true, approved: true, approved_by: "user", started_api: ["tg/event-x"], opened_assisted: [] });
    await indexed(c.index, () => c.index.getVariant(TG)?.deliveries["tg/event-x"]?.status === "published");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("skips the question for a channel the user allowed", async () => {
    const { c, publish, asked } = await setup([]);
    c.settings.update((s) => ({ ...s, publishWithoutAsking: ["tg/event-x"] }));
    expect(await c.call("publish_now", { path: TG })).toMatchObject({ ok: true, approved_by: "channel setting" });
    expect(asked).toEqual([]);
    await indexed(c.index, () => c.index.getVariant(TG)?.deliveries["tg/event-x"]?.status === "published");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("sends nothing when the post changed while the question was open (P3, review focus 3)", async () => {
    let ctx!: Awaited<ReturnType<typeof mcpCtx>>;
    const { c, publish } = await setup([
      async () => {
        await writeNote(ctx.app as never, TG, tgNote().frontmatter, "Doors open at 19:00");
        await indexed(ctx.index, () => ctx.index.getVariant(TG)!.excerpt.includes("19:00"));
        return { approved: true, how: "asked" };
      },
    ]);
    ctx = c;
    const r = await c.call("publish_now", { path: TG });
    expect(r).toMatchObject({ ok: false, approved: true });
    expect(r.error).toContain("changed after");
    expect(publish).not.toHaveBeenCalled();
  });

  it("denies a second request while one question is open", async () => {
    const { c } = await setup([], { timeoutMs: 200 });
    const first = c.call("publish_now", { path: TG });
    await new Promise((r) => setTimeout(r, 10));
    expect((await c.call("publish_now", { path: TG })).error).toBe(BUSY);
    expect((await first).error).toBe(TIMED_OUT);
  });

  it("refuses API channels on a device that is not the publisher, before asking", async () => {
    const { c, publish, asked } = await setup([{ approved: true, how: "asked" }], { publisher: false });
    const r = await c.call("publish_now", { path: TG });
    expect(r.error).toContain("publisher device");
    expect(asked).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses blocking issues and deliveries that must not be retried, before asking (P3, P4)", async () => {
    const long = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status: "scheduled" }, "a".repeat(5000)) });
    const r = await long.c.call("publish_now", { path: TG });
    expect(r.issues.map((i: R) => i.code)).toContain("too-long");
    expect(long.asked).toEqual([]);
    const stuck = await setup([{ approved: true, how: "asked" }], { note: tgNote({ status: "check_needed" }) });
    expect((await stuck.c.call("publish_now", { path: TG })).error).toBe("Nothing left to post for this note.");
    expect(stuck.asked).toEqual([]);
    expect(stuck.publish).not.toHaveBeenCalled();
  });

  it("opens the assisted flow for channels without an API after approval", async () => {
    const { c } = await setup([{ approved: true, how: "asked" }]);
    const before = Modal.opened.length;
    const r = await c.call("publish_now", { path: "Social/Event X/Event X – LinkedIn.md" });
    expect(r).toMatchObject({ ok: true, started_api: [], opened_assisted: ["li/acme-studio", "li/maker-lab"] });
    expect(r.message).toContain("assisted flow");
    expect(Modal.opened.length).toBe(before + 1);
  });
});

describe("push_update (#77)", () => {
  const live = { status: "published", at: "2026-10-08T09:00:00+02:00", url: "https://t.me/eventx/42", remote_id: "42" };

  it("pushes an edit to a live post after approval and logs it", async () => {
    const { c, update } = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    const r = await c.call("push_update", { path: TG });
    expect(r).toMatchObject({ ok: true, updated: ["tg/event-x"], failed: [] });
    expect(update).toHaveBeenCalledOnce();
    expect((update.mock.calls[0] as unknown as [R])[0].delivery.remoteId).toBe("42");
    expect(c.log.entries).toEqual([expect.objectContaining({ channelId: "tg/event-x", result: "updated", url: "https://t.me/eventx/42" })]);
  });

  it("refuses without asking when nothing is live or the platform can't update", async () => {
    const none = await setup([{ approved: true, how: "asked" }]);
    expect((await none.c.call("push_update", { path: TG })).error).toBe("No channel of this post is live on the platform with a known id.");
    const noUpdate = await setup([{ approved: true, how: "asked" }], { note: tgNote(live) });
    noUpdate.c.adapters.register({ platform: "telegram", publish: noUpdate.publish });
    expect((await noUpdate.c.call("push_update", { path: TG })).error).toBe("Telegram posts can't be updated from Obsidian yet.");
    expect([...none.asked, ...noUpdate.asked]).toEqual([]);
  });
});
```

Update `test/mcp/helpers.ts`:
```ts
import { get } from "svelte/store";
import { ApprovalGate, type ApprovalAnswer, type ApprovalRequest } from "../../src/mcp/approval";
import { registerAllTools } from "../../src/mcp/index";
import type { McpToolDeps } from "../../src/mcp/deps";
import { ToolRegistry } from "../../src/mcp/tools";
import { Secrets } from "../../src/secrets/secrets";
import { makeCtx } from "../ui/ctx";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type R = any;

export type ScriptedAnswer = ApprovalAnswer | "never" | ((req: ApprovalRequest) => Promise<ApprovalAnswer>);

/** An approval gate whose "modal" answers from a script; "never" (the default) lets it time out. */
export function scriptedApprovals(answers: ScriptedAnswer[] = [], opts: { timeoutMs?: number; allowed?: (channelId: string) => boolean } = {}) {
  const asked: ApprovalRequest[] = [];
  const gate = new ApprovalGate({
    open: (req, answer) => {
      asked.push(req);
      const next = answers.shift() ?? "never";
      if (typeof next === "function") void next(req).then(answer);
      else if (next !== "never") queueMicrotask(() => answer(next));
      return { close: () => undefined };
    },
    allowedWithoutAsking: (id) => opts.allowed?.(id) ?? false,
    timeoutMs: opts.timeoutMs ?? 50,
  });
  return { gate, asked };
}

export async function mcpCtx(opts: Parameters<typeof makeCtx>[0] & { approvals?: ApprovalGate } = {}) {
  const c = await makeCtx({ seed: true, ...opts });
  const approvals =
    opts.approvals ??
    new ApprovalGate({ open: () => ({ close: () => undefined }), allowedWithoutAsking: (id) => get(c.settings).publishWithoutAsking.includes(id), timeoutMs: 50 });
  const deps: McpToolDeps = {
    app: c.app as never,
    index: c.index,
    channels: c.ctx.channels,
    factory: c.factory,
    writer: c.writer,
    planner: c.ctx.actions,
    composer: c.ctx.composer,
    publish: c.ctx.publish,
    secrets: new Secrets(c.app as never),
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => c.publisher.isPublisher(),
    approvals,
  };
  const registry = new ToolRegistry({ redact: (text) => text });
  registerAllTools(registry, deps);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<R> => (await registry.call(name, args)).structuredContent;
  return { ...c, deps, registry, call };
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/settings/settings.test.ts test/mcp/approval.test.ts test/mcp/publish.test.ts`
Expected: FAIL — schema is 3; `Cannot find module '../../src/mcp/approval'`.

- [ ] **Step 3: Settings schema 4 and the log result**

In `src/settings/settings.ts`: `SETTINGS_VERSION = 4`; add to `OsmmSettings` (after `publisher`):
```ts
  /** Channels Claude may publish to without the approval question (#77). Everything else asks. */
  publishWithoutAsking: string[];
```
`DEFAULT_SETTINGS.publishWithoutAsking: []`; migration `3: (raw) => ({ ...raw, schemaVersion: 4, publishWithoutAsking: [] }),`; in `sanitize` (import `zChannelId` from `../model/schemas`):
```ts
    publishWithoutAsking: (Array.isArray(raw.publishWithoutAsking) ? raw.publishWithoutAsking : []).filter((id): id is string => zChannelId.safeParse(id).success),
```

In `src/publish/log.ts` add `"updated"` to the `result` union; in `src/publish/vaultLog.ts` add `updated: "updated on the platform",` to `RESULT_LABEL`.

- [ ] **Step 4: Split, prepare and send in `PublishActions`**

In `src/publish/actions.ts`, add imports:
```ts
import { PLATFORM_META } from "../model/platforms";
import type { Issue } from "../model/types";
import { effectiveMethod, platformDef } from "../platforms/registry";
import { postItems, postText } from "../platforms/text";
import { effectiveDelivery, unreadable } from "./eligibility";
```
(merge with the existing `effectiveMethod` and `effectiveDelivery` imports.) Add at module level:
```ts
/** What a send would post; an approved plan is only sent while this is unchanged (P3 for approvals). */
export function sendDigest(v: Variant, content: LoadedContent): string {
  return JSON.stringify([v.platform, v.title ?? "", v.url ?? "", content.body, v.media, v.mediaMeta ?? {}, v.wordpress ?? null]);
}

export interface SendPlan {
  path: string;
  queue: string[];
  api: string[];
  assisted: string[];
  /** The text as the platform receives it, for the approval dialog. */
  text: string;
  digest: string;
}

export interface UpdatePlan {
  path: string;
  channels: string[];
  text: string;
  digest: string;
}

export type SendRefusal = { refuse: string; issues?: Issue[] };

const GONE = "That note is no longer available.";
const BLOCKING = "The post has blocking issues, so nothing was sent.";
const CHANGED = "The post changed after it was approved, so nothing was sent. Ask again with the new text.";
const LIVE = new Set(["published", "handed_over"]);
```
Replace the API/assisted split inside `postNow` with a shared helper and add the new methods to the class:
```ts
  /** Which queued channels run through their API now, and which open the assisted flow. */
  private split(v: Variant, queue: readonly string[]): { api: string[]; assisted: string[] } {
    const adapter = this.deps.adapters.get(v.platform);
    const api = queue.filter((id) => {
      const method = effectiveMethod(v.mode, this.deps.channels.get(id), adapter);
      return method === "api" || (method === "native" && !!adapter?.publish);
    });
    return { api, assisted: queue.filter((id) => !api.includes(id)) };
  }

  /** Why API sends are refused on this device (spec §4.3: only the publisher dispatches), or null. */
  apiBlockedReason(): string | null {
    const publisher = this.context?.publisher;
    if (!publisher || publisher.isPublisher()) return null;
    const state = publisher.state();
    return state.kind === "other"
      ? `Posts go out through the API only from the publisher device (${state.name}). Ask the user to publish from there.`
      : "No device publishes through the API yet. The user can choose a publisher device in Obsidian's settings.";
  }

  /** P3 before asking: flush, re-validate the exact text, and fix what would be sent. */
  async prepareSend(path: string, channelIds?: readonly string[]): Promise<SendPlan | SendRefusal> {
    const fresh = await this.freshContent(path);
    if (!fresh) return { refuse: GONE };
    const errors = this.deps.composer.check(fresh.v, fresh.content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    const queue = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, channelIds);
    if (!queue.length) return { refuse: "Nothing left to post for this note." };
    const { api, assisted } = this.split(fresh.v, queue);
    return { path, queue, api, assisted, text: postText(fresh.content.body, platformDef(fresh.v.platform)), digest: sendDigest(fresh.v, fresh.content) };
  }

  /** P3 after approval: flush and re-validate again, and send only what was approved. */
  async sendApproved(plan: SendPlan): Promise<{ started: string[]; opened: string[] } | SendRefusal> {
    const fresh = await this.freshContent(plan.path);
    if (!fresh) return { refuse: GONE };
    const errors = this.deps.composer.check(fresh.v, fresh.content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    if (sendDigest(fresh.v, fresh.content) !== plan.digest) return { refuse: CHANGED };
    const queue = assistedQueue(fresh.v, this.deps.settings().defaultStaggerMinutes, plan.queue);
    if (!queue.length) return { refuse: "Nothing left to post for this note." };
    const { api, assisted } = this.split(fresh.v, queue);
    const blocked = api.length ? this.apiBlockedReason() : null;
    if (blocked) return { refuse: blocked };
    for (const id of api) this.runApiInBackground(plan.path, id);
    const opened = assisted.length && this.openAssisted(plan.path, assisted) ? assisted : [];
    return { started: api, opened };
  }

  /** Channels live on the platform with a known id, whose adapter can update them (spec §5.5). */
  async prepareUpdate(path: string, channelIds?: readonly string[]): Promise<UpdatePlan | SendRefusal> {
    const fresh = await this.freshContent(path);
    if (!fresh) return { refuse: GONE };
    const { v, content } = fresh;
    const errors = this.deps.composer.check(v, content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    const channels = v.channels.filter((id) => (!channelIds || channelIds.includes(id)) && !unreadable(v, id) && LIVE.has(v.deliveries[id]?.status ?? "") && !!v.deliveries[id]?.remoteId);
    if (!channels.length) return { refuse: "No channel of this post is live on the platform with a known id." };
    if (!this.deps.adapters.get(v.platform)?.update) return { refuse: `${PLATFORM_META[v.platform].label} posts can't be updated from Obsidian yet.` };
    return { path, channels, text: postText(content.body, platformDef(v.platform)), digest: sendDigest(v, content) };
  }

  async updateApproved(plan: UpdatePlan): Promise<{ updated: string[]; failed: Array<{ id: string; error: string }> } | SendRefusal> {
    const fresh = await this.freshContent(plan.path);
    if (!fresh) return { refuse: GONE };
    const { v, content } = fresh;
    const errors = this.deps.composer.check(v, content).filter((i) => i.level === "error");
    if (errors.length) return { refuse: BLOCKING, issues: errors };
    if (sendDigest(v, content) !== plan.digest) return { refuse: CHANGED };
    const blocked = this.apiBlockedReason();
    if (blocked) return { refuse: blocked };
    const adapter = this.deps.adapters.get(v.platform);
    if (!adapter?.update) return { refuse: `${PLATFORM_META[v.platform].label} posts can't be updated from Obsidian yet.` };
    const def = platformDef(v.platform);
    const items = postItems(content.body, def);
    const updated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of plan.channels) {
      const d = v.deliveries[id];
      const channel = this.deps.channels.get(id);
      if (!channel || !d || unreadable(v, id) || !LIVE.has(d.status) || !d.remoteId) {
        failed.push({ id, error: "It is no longer live with a known id." });
        continue;
      }
      const secretId = channel.secretId;
      try {
        await adapter.update({ variant: v, channel, delivery: d, text: items.join("\n\n"), items, media: def.capabilities.media.maxCount > 0 ? content.media : [], secret: secretId ? this.deps.secrets.get(secretId) : null });
        updated.push(id);
        void this.deps.log.append({ at: this.deps.now(), path: plan.path, channelId: id, result: "updated", ...(d.url ? { url: d.url } : {}) });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const error = secretId ? this.deps.secrets.redact(raw, [secretId]) : raw;
        failed.push({ id, error });
        void this.deps.log.append({ at: this.deps.now(), path: plan.path, channelId: id, result: "failed", error: `Update failed: ${error}` });
      }
    }
    return { updated, failed };
  }
```
and in `postNow`, replace the `adapter`/`viaApi`/`assisted` lines with:
```ts
    const { api, assisted } = this.split(v, queue);
    for (const id of api) this.runApiInBackground(path, id);
    if (assisted.length) this.openAssisted(path, assisted);
```

- [ ] **Step 5: Write the gate and the modal**

`src/mcp/approval.ts`:
```ts
export interface ApprovalRequest {
  action: "publish" | "update";
  title: string;
  path: string;
  platformLabel: string;
  channels: Array<{ id: string; name: string; how: string }>;
  /** The exact text as the platform receives it (clipped for display). */
  text: string;
  /** Claude's one-line reason, shown to the user. */
  note?: string;
}

export type ApprovalAnswer = { approved: true; how: "asked" | "policy" } | { approved: false; reason: string };

export interface ApprovalView {
  close(): void;
}

export interface ApprovalGateDeps {
  /** Shows the question; `answer` may be called at most once that counts. */
  open(req: ApprovalRequest, answer: (a: ApprovalAnswer) => void): ApprovalView;
  /** The per-channel setting "publish without asking" (default: ask). */
  allowedWithoutAsking(channelId: string): boolean;
  timeoutMs?: number;
}

export const APPROVAL_TIMEOUT_MS = 120_000;
export const DENIED = "The user said no in Obsidian.";
export const TIMED_OUT = "Nobody answered in Obsidian in time, so nothing was sent. Ask the user to watch Obsidian, then try again.";
export const BUSY = "Another question is already open in Obsidian. Wait for the user's answer, then try again.";
export const CLOSED = "Obsidian closed the question, so nothing was sent.";

/** In-Obsidian approval for publish tools (spec §6.1, #77): one question at a time; silence is a no. */
export class ApprovalGate {
  private pending: ((a: ApprovalAnswer) => void) | null = null;

  constructor(private readonly deps: ApprovalGateDeps) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  request(req: ApprovalRequest): Promise<ApprovalAnswer> {
    if (req.channels.length && req.channels.every((c) => this.deps.allowedWithoutAsking(c.id))) return Promise.resolve({ approved: true, how: "policy" });
    if (this.pending) return Promise.resolve({ approved: false, reason: BUSY });
    return new Promise((resolve) => {
      let done = false;
      let view: ApprovalView | null = null;
      const settle = (a: ApprovalAnswer) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        this.pending = null;
        view?.close();
        resolve(a);
      };
      const timer = window.setTimeout(() => settle({ approved: false, reason: TIMED_OUT }), this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
      this.pending = settle;
      view = this.deps.open(req, settle);
      if (done) view.close();
    });
  }

  /** Plugin unload: an open question is answered no. */
  dispose(): void {
    this.pending?.({ approved: false, reason: CLOSED });
  }
}
```

`src/mcp/ApprovalModal.ts`:
```ts
import { Modal, type App } from "obsidian";
import { DENIED, type ApprovalAnswer, type ApprovalRequest, type ApprovalView } from "./approval";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

class ApprovalModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly req: ApprovalRequest,
    private readonly answer: (a: ApprovalAnswer) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { req } = this;
    this.setTitle(req.action === "publish" ? "Claude wants to publish" : "Claude wants to update a live post");
    const c = this.contentEl;
    c.addClass("osmm", "osmm-approval");
    const n = req.channels.length;
    c.append(el("p", `${req.title} · ${req.platformLabel} · ${n} channel${n === 1 ? "" : "s"} · now`, "osmm-approval-summary"));
    const list = el("ul", undefined, "osmm-approval-channels");
    for (const ch of req.channels) list.append(el("li", `${ch.name}: ${ch.how}`));
    c.append(list);
    if (req.note) c.append(el("p", `Claude's note: ${req.note}`, "osmm-approval-note"));
    c.append(el("pre", req.text, "osmm-approval-text"));
    const reason = el("textarea");
    reason.placeholder = "Why not? (optional, sent to Claude)";
    reason.setAttribute("aria-label", "Reason for saying no, sent to Claude");
    reason.rows = 2;
    c.append(reason);
    const row = el("div", undefined, "modal-button-container");
    const approve = el("button", "Approve", "mod-cta");
    approve.type = "button";
    approve.addEventListener("click", () => this.finish({ approved: true, how: "asked" }));
    const deny = el("button", "Deny");
    deny.type = "button";
    deny.addEventListener("click", () => {
      const why = reason.value.trim();
      this.finish({ approved: false, reason: why ? `The user said no in Obsidian: ${why}` : DENIED });
    });
    row.append(approve, deny);
    c.append(row);
  }

  private finish(a: ApprovalAnswer): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(a);
    this.close();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
    // Escape or the close button: no.
    if (!this.answered) {
      this.answered = true;
      this.answer({ approved: false, reason: DENIED });
    }
  }
}

export function openApprovalModal(app: App, req: ApprovalRequest, answer: (a: ApprovalAnswer) => void): ApprovalView {
  const modal = new ApprovalModal(app, req, answer);
  modal.open();
  return { close: () => modal.close() };
}
```

Append to `src/styles/composer.css`:
```css
.osmm-approval-summary { font-weight: 600; }
.osmm-approval-channels { margin: 0 0 8px; padding-left: 1.2em; color: var(--text-muted); }
.osmm-approval-note { color: var(--text-muted); font-style: italic; }
.osmm-approval-text { max-height: 40vh; overflow: auto; white-space: pre-wrap; padding: 8px; border-radius: var(--radius-s); background: var(--background-secondary); font-family: var(--font-text); }
.osmm-approval textarea { width: 100%; margin-top: 8px; }
```

- [ ] **Step 6: Write the publish tools**

`src/mcp/tools/publish.ts`:
```ts
import { z } from "zod";
import { PLATFORM_META } from "../../model/platforms";
import { clip, findPost, noPost, zPath } from "../common";
import type { McpToolDeps } from "../deps";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const API_HOW = "posts through the API now";
const ASSISTED_HOW = "opens the assisted flow in Obsidian; you post it";

const zOnly = z.array(z.string().trim().min(1).max(80)).max(30).optional().describe("Only these channel ids; default: every channel still to post");
const zNote = z.string().trim().max(500).optional().describe("One sentence for the user, shown in the approval question");

export function registerPublishTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;

  registry.add(
    defineTool({
      name: "publish_now",
      title: "Publish now (asks the user in Obsidian)",
      description:
        "Publishes a post right now on the channels still to post. Obsidian first asks the user (what, where, when; Approve or Deny; no answer within 2 minutes is a no) unless they allowed those channels to publish without asking. API channels post from the publisher device; the others open the assisted flow in Obsidian for the user. Only call this when the user explicitly asked you to publish now; otherwise use schedule.",
      input: z.object({ path: zPath, channels: zOnly, note: zNote }).strict(),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const plan = await deps.publish.prepareSend(v.path, a.channels);
        if ("refuse" in plan) return fail(plan.refuse, plan.issues);
        const blocked = plan.api.length ? deps.publish.apiBlockedReason() : null;
        if (blocked) return fail(blocked);
        const answer = await deps.approvals.request({
          action: "publish",
          title: v.displayTitle,
          path: v.path,
          platformLabel: PLATFORM_META[v.platform].label,
          channels: plan.queue.map((id) => ({ id, name: nameOf(id), how: plan.api.includes(id) ? API_HOW : ASSISTED_HOW })),
          text: clip(plan.text, 4_000),
          ...(a.note ? { note: a.note } : {}),
        });
        if (!answer.approved) return fail(answer.reason, undefined, { approved: false });
        const sent = await deps.publish.sendApproved(plan);
        if ("refuse" in sent) return fail(sent.refuse, sent.issues, { approved: true });
        return ok({
          approved: true,
          approved_by: answer.how === "policy" ? "channel setting" : "user",
          started_api: sent.started,
          opened_assisted: sent.opened,
          message: sent.opened.length
            ? "The assisted flow is open in Obsidian: the user copies the text, posts it and pastes the live link. Check the result later with get_post."
            : "Publishing started. Check the result with get_post in a minute.",
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "push_update",
      title: "Push an edit to a live post (asks the user in Obsidian)",
      description:
        "Sends the current text of a post to the channels where it is already live (published or handed over to the platform), when the platform supports updates. Obsidian asks the user first, as for publish_now. Only call this when the user asked for it.",
      input: z.object({ path: zPath, channels: zOnly, note: zNote }).strict(),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        const plan = await deps.publish.prepareUpdate(v.path, a.channels);
        if ("refuse" in plan) return fail(plan.refuse, plan.issues);
        const blocked = deps.publish.apiBlockedReason();
        if (blocked) return fail(blocked);
        const answer = await deps.approvals.request({
          action: "update",
          title: v.displayTitle,
          path: v.path,
          platformLabel: PLATFORM_META[v.platform].label,
          channels: plan.channels.map((id) => ({ id, name: nameOf(id), how: "replaces the live text" })),
          text: clip(plan.text, 4_000),
          ...(a.note ? { note: a.note } : {}),
        });
        if (!answer.approved) return fail(answer.reason, undefined, { approved: false });
        const done = await deps.publish.updateApproved(plan);
        if ("refuse" in done) return fail(done.refuse, done.issues, { approved: true });
        return ok({ approved: true, updated: done.updated, failed: done.failed });
      },
    }),
  );
}
```

In `src/mcp/deps.ts` add `import type { ApprovalGate } from "./approval";` and the field `approvals: ApprovalGate;` (doc: "Asks the user in Obsidian before publish tools send anything."). In `src/mcp/index.ts` add `import { registerPublishTools } from "./tools/publish";` and `registerPublishTools(registry, deps);`.

- [ ] **Step 7: Wire the gate into the plugin**

In `src/main.ts`: import `ApprovalGate` from `./mcp/approval` and `openApprovalModal` from `./mcp/ApprovalModal`; add the field `approvals!: ApprovalGate;`; right before `registerAllTools(this.tools, { … })`:
```ts
    this.approvals = new ApprovalGate({
      open: (req, answer) => openApprovalModal(this.app, req, answer),
      allowedWithoutAsking: (id) => this.settings.publishWithoutAsking.includes(id),
    });
    this.register(() => this.approvals.dispose());
```
and add `approvals: this.approvals,` to the deps object passed to `registerAllTools`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS (the whole suite: the schema bump and the `postNow` refactor touch shared code).

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat(mcp): publish_now and push_update, approved in Obsidian and re-validated before sending (#77)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Claude Code settings, setup command and the status light (#78, #73 status light)

**Files:**
- Create: `src/views/McpStatusLight.svelte`, `test/views/mcpStatus.test.ts`
- Modify: `src/settings/tab.ts`, `src/ui/context.ts`, `src/views/Sidebar.svelte`, `src/main.ts`, `src/styles/planner.css`, `test/main.test.ts`

**Interfaces:**
- Consumes: `McpService` (`status`, `activity`, `token()`, `rotateToken()`, `apply()`, `setupCommand()`, `maskedSetupCommand()`, `testConnection()`), `McpStatus`, `McpActivity` (Task 3); `parsePort`, `DeviceSettings.mcp` (Task 3); `OsmmSettings.publishWithoutAsking` (Task 8); `ClipboardService.copyText`; `confirmDialog`; `formatTime`; `PLATFORM_META`.
- Produces:
  - Settings section "Claude Code" (desktop only), in this order: "Claude Code" (heading), "About Claude Code", "MCP server on this device" (toggle, off by default); when on: "Status", "Port" (text + Apply), "Connect Claude Code" (masked command in the description, **Copy setup command**), "Test connection", "Access token for Claude" (**New token**, with confirmation), "Publishing from Claude" (explanation), then one dropdown per channel named `<channel name> (<platform label>)` with "Ask me first" / "Publish without asking" (the latter confirmed).
  - `mcpStatusText(status: McpStatus, activity: McpActivity): string` (exported from `src/settings/tab.ts`).
  - `OsmmContext.mcp?: { status: Readable<McpStatus> }`; the sidebar shows "Claude Code: off | starting | ready on port N | not running" with a coloured dot (text always present, not colour alone); nothing on phones.

- [ ] **Step 1: Write the failing tests**

`test/views/mcpStatus.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { writable } from "svelte/store";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import type { McpStatus } from "../../src/mcp/service";
import { mcpStatusText } from "../../src/settings/tab";
import { makeCtx } from "../ui/ctx";

describe("Claude Code status light (#73)", () => {
  it("shows the server state in the sidebar", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const status = writable<McpStatus>({ state: "on", port: 27150 });
    const { container } = render(Sidebar, { context: osmmContext({ ...ctx, mcp: { status } }) });
    const light = () => container.querySelector(".osmm-mcp-status");
    expect(light()?.textContent).toContain("Claude Code: ready on port 27150");
    expect(light()?.getAttribute("data-state")).toBe("on");
    status.set({ state: "error", message: "Port 27150 is already in use." });
    await tick();
    expect(light()?.textContent).toContain("Claude Code: not running");
    status.set({ state: "unavailable" });
    await tick();
    expect(light()).toBeNull();
  });

  it("shows nothing when the plugin has no server (phones, tests)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const { container } = render(Sidebar, { context: osmmContext(ctx) });
    expect(container.querySelector(".osmm-mcp-status")).toBeNull();
  });
});

describe("mcpStatusText", () => {
  it("describes the state, the last call and the last refusal", () => {
    const at = Date.UTC(2026, 9, 8, 12, 5);
    expect(mcpStatusText({ state: "on", port: 27150 }, { last: { at, label: "create_variant" }, refused: { at, status: 401 } })).toBe(
      "Running on 127.0.0.1:27150. Last request from Claude: create_variant at 14:05. Last refused request at 14:05 (missing or wrong token).",
    );
    expect(mcpStatusText({ state: "error", message: "Port 27150 is already in use." }, { last: null, refused: null })).toBe("Not running: Port 27150 is already in use.");
  });
});
```

In `test/main.test.ts`, "renders the General settings and applies edits": insert `"Claude Code", "About Claude Code", "MCP server on this device",` between `"Phone reminders on this device",` and `"Channels",`. Add `ButtonComponent`, `DropdownComponent` to the fakes type import if missing, `import { browser } from "./fakes/browser";`, and inside the `describe("Claude Code server (#73)", …)` block from Task 3:
```ts
  it("sets up Claude Code from the settings without the token leaving secret storage (#78)", async () => {
    const { app, plugin } = await loaded();
    const port = await freePort();
    plugin.setDevice({ mcp: { enabled: false, port } });
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    await (last("MCP server on this device").components[0] as ToggleComponent).toggle(true);
    expect(get(plugin.mcp.status)).toEqual({ state: "on", port });
    expect(Setting.all.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Status", "Port", "Connect Claude Code", "Test connection", "Access token for Claude", "Publishing from Claude"]),
    );
    const token = plugin.mcp.token()!;
    expect(last("Connect Claude Code").desc).toContain('--header "Authorization: Bearer ••••"');
    expect(last("Connect Claude Code").desc).not.toContain(token);
    await (last("Connect Claude Code").components[0] as ButtonComponent).click();
    expect(browser.clipboard.at(-1)).toEqual({
      kind: "text",
      text: `claude mcp add --transport http --scope user --header "Authorization: Bearer ${token}" osmm http://127.0.0.1:${port}/mcp`,
    });
    await (last("Test connection").components[0] as ButtonComponent).click();
    expect(Notice.messages.at(-1)).toBe("The server answers. Claude Code can connect.");
    expect(JSON.stringify(await plugin.loadData())).not.toContain(token);
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toContain(token);
    plugin.unload();
  });

  it("rotates the token after a confirmation and validates the port (#73, #78)", async () => {
    const { plugin } = await loaded();
    const port = await freePort();
    plugin.setDevice({ mcp: { enabled: true, port } });
    await plugin.mcp.apply();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    const old = plugin.mcp.token();
    const clicked = (last("Access token for Claude").components[0] as ButtonComponent).click();
    [...Modal.opened.at(-1)!.contentEl.querySelectorAll("button")].find((b) => b.textContent === "New token")!.click();
    await clicked;
    expect(plugin.mcp.token()).not.toBe(old);
    await (last("Port").components[0] as TextComponent).change("80");
    await (last("Port").components[1] as ButtonComponent).click();
    expect(Notice.messages.at(-1)).toBe("Use a port between 1024 and 65535.");
    expect(plugin.device.mcp.port).toBe(port);
    plugin.unload();
  });

  it("lets a channel publish without asking only after a confirmation (#77)", async () => {
    const { plugin } = await loaded();
    await plugin.channels.upsertChannel({ id: "tg/event-x", platform: "telegram", name: "Event X channel", kind: "page", avatarColor: "#5cc6d6", method: "api" });
    plugin.setDevice({ mcp: { enabled: true, port: await freePort() } });
    await plugin.mcp.apply();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    Setting.all = [];
    tab.display();
    const policy = Setting.all.filter((s) => s.name === "Event X channel (Telegram)").at(-1)!.components[0] as DropdownComponent;
    expect(policy.value).toBe("ask");
    const changed = policy.change("allow");
    [...Modal.opened.at(-1)!.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Allow")!.click();
    await changed;
    expect(plugin.settings.publishWithoutAsking).toEqual(["tg/event-x"]);
    plugin.unload();
  });

  it("has no Claude Code section on phones", async () => {
    setPlatform("iphone");
    const { plugin } = await loaded();
    Setting.all = [];
    (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!.display();
    expect(Setting.all.map((s) => s.name)).not.toContain("Claude Code");
    plugin.unload();
  });
```
(`Modal` and `Notice` come from `./fakes/obsidian`; add them to the import if they are not there yet.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/views/mcpStatus.test.ts test/main.test.ts`
Expected: FAIL — no `.osmm-mcp-status`, `mcpStatusText` not exported, settings list without "Claude Code".

- [ ] **Step 3: Add the status light**

In `src/ui/context.ts`: `import type { McpStatus } from "../mcp/service";` and add to `OsmmContext`:
```ts
  /** The local MCP server's state (desktop); absent where there is none. */
  mcp?: { status: Readable<McpStatus> };
```

`src/views/McpStatusLight.svelte`:
```svelte
<script lang="ts">
  import { readable } from "svelte/store";
  import type { McpStatus } from "../mcp/service";
  import { useOsmm } from "../ui/context";

  const { mcp } = useOsmm();
  const status = mcp?.status ?? readable<McpStatus>({ state: "unavailable" });

  function label(s: McpStatus): string {
    switch (s.state) {
      case "on":
        return `Claude Code: ready on port ${s.port}`;
      case "starting":
        return "Claude Code: starting";
      case "error":
        return "Claude Code: not running";
      default:
        return "Claude Code: off";
    }
  }
</script>

{#if $status.state !== "unavailable"}
  <div class="osmm-mcp-status" data-state={$status.state} title={$status.state === "error" ? $status.message : undefined}>
    <span class="osmm-mcp-dot" aria-hidden="true"></span>
    <span>{label($status)}</span>
  </div>
{/if}
```

In `src/views/Sidebar.svelte`: `import McpStatusLight from "./McpStatusLight.svelte";` and place `<McpStatusLight />` right after `<PublisherBanner />`.

Append to `src/styles/planner.css`:
```css
.osmm-mcp-status { display: flex; align-items: center; gap: 6px; font-size: var(--font-ui-smaller); color: var(--text-muted); }
.osmm-mcp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-faint); }
.osmm-mcp-status[data-state="on"] .osmm-mcp-dot { background: var(--color-green); }
.osmm-mcp-status[data-state="starting"] .osmm-mcp-dot { background: var(--color-yellow); }
.osmm-mcp-status[data-state="error"] .osmm-mcp-dot { background: var(--color-red); }
```

In `src/main.ts`, right after `this.mcp = new McpService({ … });`: `ui.mcp = this.mcp;`.

- [ ] **Step 4: Add the settings section**

In `src/settings/tab.ts`: add `Platform` to the `obsidian` import, and
```ts
import { get } from "svelte/store";
import type { McpActivity, McpStatus } from "../mcp/service";
import { PLATFORM_META } from "../model/platforms";
import { formatTime } from "../ui/format";
import { parsePort } from "./device";
```
(merge `parsePort` into the existing `./device` import). Add near the other copy constants:
```ts
const ABOUT_CLAUDE =
  "Lets Claude Code read your plan, draft, check and schedule posts in this vault through a local MCP server. It listens on this computer only (127.0.0.1) and needs a secret token. Claude asks you here before it publishes anything.";
const CONNECT_CLAUDE = "Paste this into a terminal once. Run it again after a new token or a port change:";

export function mcpStatusText(status: McpStatus, activity: McpActivity): string {
  const parts: string[] = [];
  if (status.state === "on") parts.push(`Running on 127.0.0.1:${status.port}.`);
  else if (status.state === "starting") parts.push("Starting.");
  else if (status.state === "error") parts.push(`Not running: ${status.message}`);
  else if (status.state === "off") parts.push("Off.");
  else parts.push("Only available in Obsidian for desktop.");
  if (activity.last) parts.push(`Last request from Claude: ${activity.last.label} at ${formatTime(activity.last.at)}.`);
  if (activity.refused) {
    const why = activity.refused.status === 401 ? "missing or wrong token" : "not from this computer, or from a web page";
    parts.push(`Last refused request at ${formatTime(activity.refused.at)} (${why}).`);
  }
  return parts.join(" ");
}
```
In `display()`, right after `this.phoneSection(containerEl);`:
```ts
    if (Platform.isDesktopApp) this.claudeSection(containerEl);
```
and add the method:
```ts
  private claudeSection(containerEl: HTMLElement): void {
    const osmm = this.osmm;
    new Setting(containerEl).setName("Claude Code").setHeading();
    new Setting(containerEl).setName("About Claude Code").setDesc(ABOUT_CLAUDE);
    new Setting(containerEl)
      .setName("MCP server on this device")
      .setDesc("Off by default. Stored on this device only; the token stays in this device's secret storage.")
      .addToggle((t) =>
        t.setValue(osmm.device.mcp.enabled).onChange(async (value) => {
          osmm.setDevice({ mcp: { ...osmm.device.mcp, enabled: value } });
          await osmm.mcp.apply();
          this.display();
        }),
      );
    if (!osmm.device.mcp.enabled) return;

    new Setting(containerEl).setName("Status").setDesc(mcpStatusText(get(osmm.mcp.status), get(osmm.mcp.activity)));

    let port = String(osmm.device.mcp.port);
    new Setting(containerEl)
      .setName("Port")
      .setDesc("From 1024 to 65535; 27150 by default. Run the setup command again after a change.")
      .addText((t) => t.setValue(port).onChange((value) => void (port = value)))
      .addButton((b) =>
        b.setButtonText("Apply").onClick(async () => {
          const parsed = parsePort(port);
          if (parsed === null) {
            new Notice("Use a port between 1024 and 65535.");
            return;
          }
          osmm.setDevice({ mcp: { ...osmm.device.mcp, port: parsed } });
          await osmm.mcp.apply();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Connect Claude Code")
      .setDesc(`${CONNECT_CLAUDE} ${osmm.mcp.maskedSetupCommand()}`)
      .addButton((b) =>
        b
          .setButtonText("Copy setup command")
          .setCta()
          .onClick(async () => {
            const command = osmm.mcp.setupCommand();
            if (command && (await new ClipboardService(this.app).copyText(command))) new Notice("Setup command copied. Paste it into a terminal; it contains your token, so don't share it.");
          }),
      );

    new Setting(containerEl).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        const result = await osmm.mcp.testConnection();
        new Notice(result.ok ? "The server answers. Claude Code can connect." : `No connection: ${result.message}`);
      }),
    );

    new Setting(containerEl)
      .setName("Access token for Claude")
      .setDesc("Stored in this device's secret storage. A new token disconnects Claude Code until you run the new setup command.")
      .addButton((b) =>
        b.setButtonText("New token").onClick(async () => {
          const ok = await confirmDialog(this.app, "Make a new token? Claude Code stops connecting until you copy and run the setup command again.", "New token");
          if (!ok) return;
          osmm.mcp.rotateToken();
          new Notice("New token made. Copy the setup command again.");
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Publishing from Claude")
      .setDesc("Claude asks you in Obsidian before it publishes or updates a live post. Allow a channel below to skip that question; every other channel still asks.");
    for (const channel of osmm.channels.list()) {
      new Setting(containerEl).setName(`${channel.name} (${PLATFORM_META[channel.platform].label})`).addDropdown((d) =>
        d
          .addOption("ask", "Ask me first")
          .addOption("allow", "Publish without asking")
          .setValue(osmm.settings.publishWithoutAsking.includes(channel.id) ? "allow" : "ask")
          .onChange(async (value) => {
            if (value === "allow" && !(await confirmDialog(this.app, `Let Claude publish to ${channel.name} without asking you first?`, "Allow"))) {
              d.setValue("ask");
              return;
            }
            const next = new Set(osmm.settings.publishWithoutAsking);
            if (value === "allow") next.add(channel.id);
            else next.delete(channel.id);
            await osmm.updateSettings({ publishWithoutAsking: [...next] });
          }),
      );
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(mcp): Claude Code settings with setup command, connection test, token and publish policy; sidebar status light (#78, #73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Notes written while Obsidian was closed are held for review (#84, plugin side)

**Files:**
- Create: `src/views/ClaudeDrafts.svelte`, `test/composer/claudeDrafts.test.ts`, `test/views/claudeSidebar.test.ts`
- Modify: `src/model/types.ts`, `src/model/frontmatter.ts`, `src/index/queries.ts`, `src/scheduler/due.ts`, `src/reminders/reminders.ts`, `src/composer/actions.ts`, `src/views/Sidebar.svelte`, `src/mcp/present.ts`, `src/mcp/tools/schedule.ts`, `src/main.ts`, `test/model/frontmatter.test.ts`, `test/main.test.ts`, `test/mcp/schedule.test.ts`

**Interfaces:**
- Consumes: `planComposerSchedule`, `reminderDefaults` (`src/composer/schedule.ts`); `unscheduleBlocked`, `unscheduleDeliveries`, `UNSCHEDULE_BLOCKED` (`src/planner/board.ts`); `deliveryChanges`; `PlannerActions.write/afterWrite/actionNotice`; `activateView`, `VIEW_SIDEBAR`.
- Produces:
  - `Variant.review?: "claude"` parsed from frontmatter `review: claude` (any other value is a warning and ignored); `VariantPatch` gains `review` (`undefined` deletes the key).
  - `heldForReview(v: Pick<Variant, "review">): boolean` in `src/index/queries.ts`. `dueItems` and `reminderSlots` skip held notes, so there is no dispatch, overdue marking, desktop reminder or ntfy booking until review.
  - `ComposerActions.reviewIssues(v): Promise<Issue[]>`, `approveClaudeDraft(v): Promise<boolean>` (validates, needs a future `scheduled_at`, schedules with `planComposerSchedule` and removes `review` in one write, with Undo), `keepClaudeDraft(v): Promise<boolean>` (removes `review`, status `draft`, unschedules deliveries).
  - Sidebar section "Written by Claude · N" (`ClaudeDrafts.svelte`); a start-up notice "N post(s) written by Claude need(s) your review." with **Review**.
  - MCP `schedule` removes `review` (the plugin validated the post); `postSummary` includes `review` when set.

- [ ] **Step 1: Write the failing tests**

Add to `test/model/frontmatter.test.ts` (inside the `parseVariant` describe):
```ts
  it("reads review: claude and warns about other values", () => {
    const base = { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "ready" };
    expect(parseVariant({ ...base, review: "claude" }, "p.md").value!.review).toBe("claude");
    const other = parseVariant({ ...base, review: "yes" }, "p.md");
    expect(other.value!.review).toBeUndefined();
    expect(other.issues).toEqual([expect.objectContaining({ level: "warning", field: "review" })]);
  });
```

`test/composer/claudeDrafts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { reminderSlots } from "../../src/reminders/reminders";
import { dueItems } from "../../src/scheduler/due";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Event X/Event X – Mastodon.md";
const MIN = 60_000;
const offline = (over: Record<string, unknown> = {}, body = "Event X is back on the 12th.") => ({
  path: P,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "ready", review: "claude", scheduled_at: "2026-10-09T10:00:00+02:00", ...over },
  body,
});
async function fm(c: TestCtx): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter);
}

describe("notes written by Claude with Obsidian closed (#84)", () => {
  it("are never dispatched, marked overdue or reminded about, even when they claim to be scheduled (review focus 5)", async () => {
    const due = "2026-10-08T09:59:00+02:00";
    const held = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", scheduled_at: due, deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(dueItems(held.index.variants(), TEST_NOW, 15).map((i) => i.path)).not.toContain(P);
    const soon = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", scheduled_at: "2026-10-08T10:30:00+02:00", deliveries: { "ma/you": { status: "scheduled" } }, reminders: [60, 10] })] });
    expect(reminderSlots(soon.ctx.actions.rows(), TEST_NOW, TEST_NOW + 60 * MIN, TEST_NOW, (r) => r.variant.reminders ?? null).map((i) => i.path)).not.toContain(P);
    const released = await makeCtx({ seed: true, notes: [offline({ review: undefined, status: "scheduled", scheduled_at: due, deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(dueItems(released.index.variants(), TEST_NOW, 15).map((i) => i.path)).toContain(P);
  });

  it("are approved and scheduled in one write, with Undo", async () => {
    const c = await makeCtx({ seed: true, notes: [offline()] });
    expect(await c.ctx.composer.approveClaudeDraft(c.index.getVariant(P)!)).toBe(true);
    await indexed(c.index, () => c.index.getVariant(P)?.review === undefined);
    const after = await fm(c);
    expect(after.review).toBeUndefined();
    expect(after.status).toBe("scheduled");
    expect(after.deliveries).toEqual({ "ma/you": { status: "scheduled" } });
    expect(Notice.messages.at(-1)).toContain("Approved and scheduled");
  });

  it("are not approved with blocking issues or a past time", async () => {
    const long = await makeCtx({ seed: true, notes: [offline({}, "a".repeat(600))] });
    expect(await long.ctx.composer.approveClaudeDraft(long.index.getVariant(P)!)).toBe(false);
    expect(Notice.messages.at(-1)).toContain("The text is 600/500 characters.");
    expect((await fm(long)).review).toBe("claude");
    const late = await makeCtx({ seed: true, notes: [offline({ scheduled_at: "2026-10-08T09:00:00+02:00" })] });
    expect(await late.ctx.composer.approveClaudeDraft(late.index.getVariant(P)!)).toBe(false);
    expect(Notice.messages.at(-1)).toBe("The proposed time has passed. Pick a new time in the composer.");
  });

  it("can be kept as a draft, which unschedules whatever they claimed", async () => {
    const c = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(await c.ctx.composer.keepClaudeDraft(c.index.getVariant(P)!)).toBe(true);
    const after = await fm(c);
    expect([after.review, after.status, after.deliveries]).toEqual([undefined, "draft", { "ma/you": { status: "draft" } }]);
  });
});
```

`test/views/claudeSidebar.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const note = (path: string, body: string) => ({
  path,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "ready", review: "claude", scheduled_at: "2026-10-09T10:00:00+02:00" },
  body,
});

describe("Written by Claude (#84)", () => {
  it("lists held notes with their first blocking issue, and approves the valid one", async () => {
    const { ctx, index } = await makeCtx({ seed: true, notes: [note("Social/Event X/A.md", "Short and fine."), note("Social/Event X/B.md", "a".repeat(600))] });
    render(Sidebar, { context: osmmContext(ctx) });
    const section = screen.getByRole("region", { name: "Written by Claude · 2" });
    expect(await screen.findByText("The text is 600/500 characters.")).toBeTruthy();
    expect(section.textContent).toContain("Ready for");
    const approve = screen.getAllByRole("button", { name: /^Approve and schedule/ });
    expect(approve.map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true]);
    await fireEvent.click(approve[0]!);
    await indexed(index, () => index.getVariant("Social/Event X/A.md")?.review === undefined);
    expect(index.getVariant("Social/Event X/A.md")!.status).toBe("scheduled");
  });
});
```

Add to `test/mcp/schedule.test.ts` (inside `describe("schedule (#75)", …)`):
```ts
  it("releases a note written offline once the plugin has validated and scheduled it", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Offline.md", frontmatter: { type: "social-post", platform: "mastodon", title: "Offline", channels: ["ma/you"], status: "ready", review: "claude" }, body: "Written while Obsidian was closed." }],
    });
    expect((await c.call("get_post", { path: "Social/Posts/Offline.md" })).review).toBe("claude");
    expect((await c.call("schedule", { path: "Social/Posts/Offline.md", at: FRI_9 })).ok).toBe(true);
    expect((await fm(c, "Social/Posts/Offline.md")).review).toBeUndefined();
  });
```

Add to `test/main.test.ts` (inside `describe("OsmmPlugin", …)`):
```ts
  it("tells the user at start-up about notes Claude wrote while Obsidian was closed (#84)", async () => {
    const app = new App();
    await writeNote(app as never, "Social/Posts/Offline.md", { type: "social-post", platform: "mastodon", title: "Offline", channels: [], status: "ready", review: "claude" }, "Hi");
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await settle();
    expect(Notice.messages.some((m) => m.startsWith("1 post written by Claude needs your review."))).toBe(true);
    plugin.unload();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/frontmatter.test.ts test/composer/claudeDrafts.test.ts test/views/claudeSidebar.test.ts test/mcp/schedule.test.ts test/main.test.ts`
Expected: FAIL — `review` not parsed; `approveClaudeDraft` is not a function; no "Written by Claude" region.

- [ ] **Step 3: Model and queries**

In `src/model/types.ts`, add to `Variant` (after `invalidDeliveries`):
```ts
  /** "claude": written by the /social skill while Obsidian was closed; held from posting and reminders until reviewed (#84). */
  review?: "claude";
```
In `src/model/frontmatter.ts`, in `parseVariant` right after `if (invalidDeliveries.length) …`:
```ts
  if (!isBlank(fm.review)) {
    if (fm.review === "claude") variant.review = "claude";
    else issues.push({ level: "warning", field: "review", message: 'review can only be "claude" (set by the /social skill on notes written while Obsidian was closed).' });
  }
```
add `| "review"` to the `VariantPatch` pick list, and to `variantFields`:
```ts
  if ("review" in patch) out.review = patch.review;
```
In `src/index/queries.ts` (`import type { DeliveryStatus, Variant } from "../model/types";`):
```ts
/** A note the /social skill wrote while Obsidian was closed: nothing posts or reminds until the user reviews it (#84). */
export function heldForReview(v: Pick<Variant, "review">): boolean {
  return v.review === "claude";
}
```
In `src/scheduler/due.ts` import `heldForReview` from `../index/queries` and add after the `unreadable` line:
```ts
    if (heldForReview(r.variant)) continue;
```
In `src/reminders/reminders.ts` import `heldForReview` next to `unreadableRow` and extend the skip condition in `reminderSlots`: `… || unreadableRow(row) || heldForReview(row.variant)) continue;`.

- [ ] **Step 4: Review actions**

In `src/composer/actions.ts`: import `reminderDefaults` from `./schedule` and `UNSCHEDULE_BLOCKED, unscheduleBlocked, unscheduleDeliveries` from `../planner/board` (next to `scheduleDeliveries`), then add to `ComposerActions`:
```ts
  /** The plugin's checks on a note Claude wrote with Obsidian closed (#84), as the note is now. */
  async reviewIssues(v: IndexedVariant): Promise<Issue[]> {
    return this.check(v, await this.content.load(v));
  }

  /** "Approve & schedule": validated here, scheduled at its proposed time, released from review, in one write. */
  async approveClaudeDraft(v: IndexedVariant): Promise<boolean> {
    const errors = (await this.reviewIssues(v)).filter((i) => i.level === "error");
    if (errors.length) {
      new Notice(`Fix these first: ${errors.map((i) => i.message).join(" ")}`);
      return false;
    }
    const at = v.scheduledAt;
    if (at === undefined) {
      new Notice("Set a time in the composer first.");
      return false;
    }
    if (at <= this.deps.now()) {
      new Notice("The proposed time has passed. Pick a new time in the composer.");
      return false;
    }
    const reminders = reminderDefaults(v, this.channelsOf(v), this.deps.settings());
    const stagger = this.deps.settings().defaultStaggerMinutes;
    const result = await this.deps.planner.write(v.file, (fresh) => {
      if (fresh.review !== "claude") return { refuse: "This post was already reviewed." };
      if (fresh.scheduledAt !== at) return { refuse: "The proposed time changed. Check the post again." };
      const plan = planComposerSchedule(fresh, { at, reminders }, stagger);
      if ("refuse" in plan) return plan;
      return { fields: { ...plan.fields, review: undefined }, deliveries: deliveryChanges(fresh, plan.deliveries as Record<string, Delivery>) };
    });
    this.deps.planner.afterWrite(result, `Approved and scheduled for ${formatShortDate(at)} ${formatTime(at)}.`);
    return result.ok;
  }

  /** "Keep as draft": no longer held, and nothing of it stays scheduled. */
  async keepClaudeDraft(v: IndexedVariant): Promise<boolean> {
    const result = await this.deps.planner.write(v.file, (fresh) => {
      if (fresh.review !== "claude") return { refuse: "This post was already reviewed." };
      if (unscheduleBlocked(fresh)) return { refuse: UNSCHEDULE_BLOCKED };
      return { fields: { review: undefined, status: "draft" }, deliveries: deliveryChanges(fresh, unscheduleDeliveries(fresh, "draft")) };
    });
    this.deps.planner.afterWrite(result, "Kept as a draft.");
    return result.ok;
  }
```

- [ ] **Step 5: Sidebar section and start-up notice**

`src/views/ClaudeDrafts.svelte`:
```svelte
<script lang="ts">
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  const { snapshot, composer, actions } = useOsmm();
  const drafts = $derived(
    $snapshot.variants
      .filter((v) => v.review === "claude")
      .sort((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path)),
  );
</script>

{#if drafts.length}
  <section class="osmm-claude-drafts" aria-label={`Written by Claude · ${drafts.length}`}>
    <h3 class="osmm-section-title">Written by Claude · {drafts.length}</h3>
    {#each drafts as v (v.path)}
      <div class="osmm-row">
        <PlatformBadge platform={v.platform} />
        <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(v.path)}>{v.displayTitle}</button>
      </div>
      {#await composer.reviewIssues(v)}
        <p class="osmm-progress">Checking…</p>
      {:then issues}
        {@const errors = issues.filter((i) => i.level === "error")}
        <p class="osmm-progress">
          {#if errors.length}{errors[0]?.message}{:else if v.scheduledAt !== undefined}Ready for {formatShortDate(v.scheduledAt)} {formatTime(v.scheduledAt)}{:else}Ready. No time proposed yet.{/if}
        </p>
        <div class="osmm-row">
          <span class="osmm-spacer"></span>
          <button
            type="button"
            class="mod-cta"
            aria-label={`Approve and schedule ${v.displayTitle}`}
            disabled={errors.length > 0 || v.scheduledAt === undefined}
            onclick={() => void composer.approveClaudeDraft(v)}>Approve & schedule</button
          >
          <button type="button" aria-label={`Keep ${v.displayTitle} as a draft`} onclick={() => void composer.keepClaudeDraft(v)}>Keep as draft</button>
        </div>
      {/await}
    {/each}
  </section>
{/if}
```
In `src/views/Sidebar.svelte`: `import ClaudeDrafts from "./ClaudeDrafts.svelte";` and put `<ClaudeDrafts />` right before `<section aria-label="Up next · today">`.

In `src/main.ts`, in `onLayoutReady` right after the `ui.publish.overdueBanner(…)` line (import `VIEW_SIDEBAR` is already there; import `activateView` from `./views/PlannerView`):
```ts
      const held = this.index.variants().filter((v) => v.review === "claude").length;
      if (held) {
        const message = `${held} post${held === 1 ? "" : "s"} written by Claude need${held === 1 ? "s" : ""} your review.`;
        ui.actions.actionNotice(message, "Review", () => activateView(this.app, VIEW_SIDEBAR, "right"));
      }
```

- [ ] **Step 6: MCP schedule releases, summaries show the flag**

In `src/mcp/tools/schedule.ts`, in `schedule`'s plan, return `{ fields: { ...plan.fields, review: undefined }, deliveries: … }` (the plugin just validated the post). In `src/mcp/present.ts` `postSummary`, add `...(v.review ? { review: v.review } : {}),` after `chars`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat(claude): hold notes written while Obsidian was closed until the user reviews them (#84)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Claude Code plugin, marketplace entry and the /social workflow (#80, #81)

**Files:**
- Create: `.claude-plugin/marketplace.json`, `claude-plugin/.claude-plugin/plugin.json`, `claude-plugin/README.md`, `claude-plugin/skills/social/SKILL.md`, `test/claude/package.test.ts`
- Modify: `scripts/version-bump.mjs`, `package.json` (`version` script)

**Interfaces:**
- Consumes: the tool names from Tasks 4–8 (and Task 14's three voice tools, which SKILL.md already names); `manifest.json`'s version.
- Produces:
  - Marketplace `osmm-social-planner` at the repo root; plugin entry `osmm` with `source: "./claude-plugin"`. Install: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management` then `claude plugin install osmm@osmm-social-planner`; the skill runs as `/osmm:social`.
  - `claude-plugin/.claude-plugin/plugin.json` whose `version` always equals `manifest.json`'s (`npm version` updates both).
  - `SKILL.md` with frontmatter `name: social`, `description`, `argument-hint`, and links to `references/tools.md`, `references/file-format.md`, `references/voice.md`, `references/review-page.md` and the 13 `references/platforms/<platform>.md` (written in Tasks 12–14; Task 14 tests every link).
- **(QA)** Format details that could not be run here: `claude plugin validate .` passes; the marketplace `owner` needs only `name`; the relative `source` resolves from the repo root; the skill's frontmatter fields are accepted. `docs/qa/m4.md` (Task 15) lists them.

- [ ] **Step 1: Write the failing tests**

`test/claude/package.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFrontMatterInfo } from "obsidian";
import YAML from "yaml";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

describe("Claude Code plugin packaging (#80)", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  const entry = (marketplace.plugins as Array<Record<string, unknown>>)[0]!;

  it("has a marketplace at the repo root with one plugin entry", () => {
    expect(marketplace.name).toBe("osmm-social-planner");
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/);
    expect(marketplace.owner).toEqual({ name: "dannickstark" });
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry).toMatchObject({ name: "osmm", source: "./claude-plugin" });
    expect(String(entry.source)).not.toContain("..");
  });

  it("points at a plugin whose manifest name and version match (versions aligned with the Obsidian plugin)", () => {
    const pluginPath = join(String(entry.source), ".claude-plugin/plugin.json");
    expect(existsSync(join(ROOT, pluginPath))).toBe(true);
    const plugin = json(pluginPath);
    expect(plugin.name).toBe(entry.name);
    expect(plugin.version).toBe(json("manifest.json").version);
    expect(plugin.license).toBe("MIT");
    expect(() => new URL(String(plugin.homepage))).not.toThrow();
  });

  it("ships the social skill with a usable description", () => {
    const text = readFileSync(join(ROOT, "claude-plugin/skills/social/SKILL.md"), "utf8");
    const info = getFrontMatterInfo(text);
    const fm = YAML.parse(info.frontmatter) as Record<string, string>;
    expect(fm.name).toBe("social");
    expect(fm.description.length).toBeGreaterThan(100);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toContain("Obsidian");
    const body = text.slice(info.contentStart);
    expect(body).toContain("Never publish without");
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("bumps the Claude plugin's version together with the Obsidian plugin's", () => {
    const dir = mkdtempSync(join(tmpdir(), "osmm-bump-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "0.1.0", minAppVersion: "1.11.4" }));
    writeFileSync(join(dir, "versions.json"), "{}");
    mkdirSync(join(dir, "claude-plugin/.claude-plugin"), { recursive: true });
    writeFileSync(join(dir, "claude-plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "osmm", version: "0.1.0" }));
    execFileSync(process.execPath, [join(ROOT, "scripts/version-bump.mjs")], { cwd: dir, env: { ...process.env, npm_package_version: "0.4.0" } });
    expect(JSON.parse(readFileSync(join(dir, "claude-plugin/.claude-plugin/plugin.json"), "utf8"))).toEqual({ name: "osmm", version: "0.4.0" });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version).toBe("0.4.0");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/claude/package.test.ts`
Expected: FAIL — `ENOENT … .claude-plugin/marketplace.json`.

- [ ] **Step 3: Write the marketplace and the plugin manifest**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "osmm-social-planner",
  "description": "Claude Code plugin for the Social Planner (OSMM) Obsidian plugin: the /social skill, platform playbooks and the voice profile.",
  "owner": { "name": "dannickstark" },
  "plugins": [
    {
      "name": "osmm",
      "source": "./claude-plugin",
      "description": "Plan, draft, check and schedule social media campaigns in your Obsidian vault from one conversation (/osmm:social)."
    }
  ]
}
```

`claude-plugin/.claude-plugin/plugin.json`:
```json
{
  "name": "osmm",
  "displayName": "Social Planner (OSMM)",
  "version": "0.1.0",
  "description": "The /social skill for the Social Planner (OSMM) Obsidian plugin: turns one conversation into a planned, checked and scheduled social campaign, with platform playbooks and your voice profile.",
  "author": { "name": "dannickstark", "url": "https://github.com/dannickstark" },
  "homepage": "https://github.com/dannickstark/Obsidian-Social-media-management",
  "repository": "https://github.com/dannickstark/Obsidian-Social-media-management",
  "license": "MIT",
  "keywords": ["obsidian", "social-media", "content-calendar", "scheduling", "mcp"]
}
```
Set `"version"` to whatever `manifest.json` holds on the branch (the test compares them).

`claude-plugin/README.md`:
```markdown
# Social Planner (OSMM) for Claude Code

The `/osmm:social` skill plans, drafts, checks and schedules social media campaigns in your Obsidian vault, through the Social Planner (OSMM) plugin's local MCP server.

## Install
1. In a terminal: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`
2. Then: `claude plugin install osmm@osmm-social-planner`
3. In Obsidian: **Settings → Social Planner → Claude Code**, turn on **MCP server on this device**, click **Copy setup command** and run it in a terminal. This connects Claude Code to your vault; the command contains a secret token, so don't share it.

## Use
In Claude Code, type `/osmm:social` followed by what you want, for example `/osmm:social plan the Event X launch for LinkedIn, X and Mastodon`. Claude reads the campaign and your voice profile, proposes a plan, drafts each post, checks it with the plugin and schedules it after you agree. It never publishes unless you ask, and Obsidian asks you to approve before anything goes out.

When Obsidian is closed, run Claude Code inside your vault folder: the skill then writes the notes directly, and Obsidian shows them under **Written by Claude** for you to approve the next time it opens.
```

- [ ] **Step 4: Write the skill**

`claude-plugin/skills/social/SKILL.md`:
```markdown
---
name: social
description: Plan, draft, check and schedule social media campaigns in the user's Obsidian vault with the Social Planner (OSMM) plugin. Use when the user wants to plan a campaign or launch, write posts for LinkedIn, X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit or WhatsApp, write a WordPress article, find posting times, put posts on the calendar, or review what is planned.
argument-hint: "[campaign note, brief or goal]"
---

# Social campaigns in Obsidian

You turn a brief into a planned, checked and scheduled campaign in the user's Obsidian vault. The vault holds one note per campaign and one note per platform variant; the Social Planner plugin checks them, shows them on a calendar, reminds the user and posts where it can.

## Rules
1. **Never publish without the user's explicit request in this conversation** ("post it now", "publish the LinkedIn one"). Planning, drafting and scheduling are not publishing. Even then, Obsidian asks the user to approve: tell them to look at Obsidian.
2. Schedule only after the user agreed to the plan and to the drafts.
3. Write in the user's voice. Read the voice profile first and say which of its rules you applied, e.g. "Voice: short sentences, first person, no hashtags (from _voice.md)". If there is no profile, offer to create one ([voice.md](references/voice.md)).
4. Don't invent facts, numbers, quotes, dates, names or links. Ask, or leave a marked gap such as `[date?]` and tell the user.
5. Only http(s) links. No emoji unless the voice profile asks for them.
6. Fix every issue with level `error` before writing or scheduling; mention warnings to the user.

## Step 0: how to reach the vault
Call `list_channels`. If it answers, work through the MCP tools ([tools.md](references/tools.md)). If the tool is missing or the server doesn't answer, you are in **offline mode**: tell the user that Obsidian's Claude Code server isn't reachable and that you will write the notes directly for them to approve in Obsidian later, then follow [file-format.md](references/file-format.md) exactly. Offline mode needs Claude Code to run inside the vault folder; nothing gets posted or reminded in this mode until the user approves each note in Obsidian.

## Workflow
1. **Read.** `get_campaign` for the campaign the user named (brief, existing posts, platforms without a post), `get_voice_profile`, `list_channels`, and `get_platform_rules` for the platforms in play. For a new campaign, ask for the brief.
2. **Clarify** in one message, only what is missing: goal, audience, call to action and link, key date (the anchor date), channels, constraints (tone, words to avoid, legal).
3. **Plan.** Propose a table: platform, channels, when (relative to the anchor date, e.g. T-7 09:00, and the actual date), angle. Use `find_free_slots` for the times. Ask the user to confirm or change it.
4. **Draft** each variant with its playbook: load only the playbooks of the platforms in the plan (list below). One idea per post; adapt to each platform instead of copying.
5. **Check** each draft with `validate` (`draft`) before writing. Fix errors. Show the user every draft with its length and warnings.
6. **Write** after the user is happy with the drafts: `create_campaign` if the campaign doesn't exist (with the brief and anchor date), then `create_variant` per post with a fresh `idempotency_key` (reuse the same key only when retrying that same post). Use `update_variant` for changes and `fork_variant` when one page needs its own text.
7. **Schedule** after the user said yes: `schedule` per post. If it answers `needs_confirmation: "move_awaiting"`, ask the user before calling it again with `move_awaiting: true`. A past time or a blocking issue means fix and try again; never force.
8. **Summarise**: a table of post, channels, time, status and note path, and what the user still has to do (channels marked assisted remind them to post).
9. Optional: offer a review page for sign-off ([review-page.md](references/review-page.md)).

## Publishing now
Only when the user asks: `publish_now` with a one-sentence `note` explaining why. Tell the user that Obsidian is asking them. If the answer is a no or a timeout, pass the reason on and don't retry unless asked. For a post that is already live, `push_update` works the same way where the platform supports it.

## Voice profile
`get_voice_profile` returns the user's voice note (`Social/_voice.md`). To refine it from posts that worked, follow [voice.md](references/voice.md): read published posts, propose three to five concrete rules, and only after the user agrees call `add_voice_refinement`.

## References
Load a reference only when the step needs it.
- [tools.md](references/tools.md): every MCP tool and its arguments.
- [file-format.md](references/file-format.md): the note format for offline mode.
- [voice.md](references/voice.md): the voice profile template and how to refine it.
- [review-page.md](references/review-page.md): a shareable review page, and recording decisions in the campaign.
- Playbooks: [LinkedIn](references/platforms/linkedin.md), [X](references/platforms/x.md), [Instagram](references/platforms/instagram.md), [Facebook](references/platforms/facebook.md), [Mastodon](references/platforms/mastodon.md), [Bluesky](references/platforms/bluesky.md), [Telegram](references/platforms/telegram.md), [Discord](references/platforms/discord.md), [Hacker News](references/platforms/hackernews.md), [Indie Hackers](references/platforms/indiehackers.md), [Reddit](references/platforms/reddit.md), [WhatsApp](references/platforms/whatsapp.md), [WordPress](references/platforms/wordpress.md).
```

- [ ] **Step 5: Keep the versions aligned**

`scripts/version-bump.mjs` — append:
```js
const pluginPath = "claude-plugin/.claude-plugin/plugin.json";
const claudePlugin = JSON.parse(readFileSync(pluginPath, "utf8"));
claudePlugin.version = target;
writeFileSync(pluginPath, `${JSON.stringify(claudePlugin, null, 2)}\n`);
```
In `package.json`, change the `version` script to:
```json
"version": "node scripts/version-bump.mjs && git add manifest.json versions.json claude-plugin/.claude-plugin/plugin.json"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/claude/package.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin claude-plugin scripts/version-bump.mjs package.json test/claude/package.test.ts
git commit -m "feat(claude): Claude Code plugin with the /social skill and a marketplace entry (#80, #81)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Tool reference and the offline file-format reference (#81, #84 skill side)

**Files:**
- Create: `claude-plugin/skills/social/references/tools.md`, `claude-plugin/skills/social/references/file-format.md`, `test/claude/references.test.ts`

**Interfaces:**
- Consumes: `registerAllTools` / `mcpCtx` (Tasks 4–8) for the list of tool names; `parseVariant`, `parseCampaign`, `socialKind` (`src/model/frontmatter.ts`); `validateAll`; `migrateSettings`; `buildSeed` (seed channels).
- Produces: `tools.md` with one `### <tool_name>` section per registered tool (the test keeps the two sets equal); `file-format.md` whose example notes (fenced with four backticks and `markdown`) parse without issues and validate without errors, and follow the offline rules (`status: ready`, `review: claude`, no `deliveries`).

- [ ] **Step 1: Write the failing tests**

`test/claude/references.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { buildSeed } from "../../scripts/seedData";
import { parseCampaign, parseVariant, socialKind } from "../../src/model/frontmatter";
import { validateAll } from "../../src/platforms/checks";
import { migrateSettings } from "../../src/settings/settings";
import { mcpCtx } from "../mcp/helpers";
import { TEST_NOW } from "../ui/ctx";

const REFS = fileURLToPath(new URL("../../claude-plugin/skills/social/references/", import.meta.url));
const read = (name: string) => readFileSync(join(REFS, name), "utf8");
const EXAMPLE_RE = /^(`{4,})markdown\n([\s\S]*?)^\1$/gm;

describe("skill references", () => {
  it("documents exactly the tools the server offers", async () => {
    const c = await mcpCtx();
    const documented = [...read("tools.md").matchAll(/^### ([a-z_]+)$/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(c.registry.names().sort());
    // Every input schema converts to JSON Schema (tools/list would fail for Claude otherwise).
    expect(c.registry.list().every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("gives offline examples that the plugin reads without issues and that pass its checks (#84)", () => {
    const channels = migrateSettings(buildSeed(TEST_NOW).settings).channels;
    const blocks = [...read("file-format.md").matchAll(EXAMPLE_RE)].map((m) => m[2]!);
    const kinds = blocks.map((text) => {
      const info = getFrontMatterInfo(text);
      const fm = parseYaml(info.frontmatter) as Record<string, unknown>;
      const kind = socialKind(fm);
      if (kind === "campaign") {
        expect(parseCampaign(fm, "Social/Event X/Event X.md").issues).toEqual([]);
        return kind;
      }
      expect(kind).toBe("post");
      expect([fm.status, fm.review, fm.deliveries]).toEqual(["ready", "claude", undefined]);
      const parsed = parseVariant(fm, "Social/Event X/Example.md");
      expect(parsed.issues).toEqual([]);
      const v = parsed.value!;
      const errors = validateAll({ variant: v, body: text.slice(info.contentStart), media: [] }, channels.filter((ch) => v.channels.includes(ch.id))).filter((i) => i.level === "error");
      expect(errors).toEqual([]);
      return kind;
    });
    expect(kinds.filter((k) => k === "campaign")).toHaveLength(1);
    expect(kinds.filter((k) => k === "post").length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/claude/references.test.ts`
Expected: FAIL — `ENOENT … references/tools.md`.

- [ ] **Step 3: Write the tool reference**

`claude-plugin/skills/social/references/tools.md`:
```markdown
# Social Planner MCP tools

All tools answer with JSON: `ok: true` plus data, or `ok: false` with `error` and, when the plugin found problems, `issues` (`level` error or warning, `field`, `message`, `code`). Errors must be fixed; warnings are for the user to decide. Times are ISO 8601 with an offset, e.g. `2026-10-08T17:30:00+02:00`. Paths are vault paths as the list tools return them. Channels are ids such as `li/acme-studio`, or `group:<id>` for a channel group.

## Read

### list_channels
The places posts go to: `id`, `platform`, `name`, `method` (`api` posts by itself, `native` is handed to the platform, `assisted` reminds the user to post), usual time and reminders; and the channel groups. `platform` filters. Never returns credentials.

### list_campaigns
Campaigns by anchor date with post counts and progress. `status`: `active` (default), `archived` or `all`.

### get_campaign
One campaign: fields, `brief` (the note's text), `posts` with per-channel status, and `missing_platforms` (platforms with channels but no post yet). Start here.

### list_posts
Posts filtered by `campaign`, `platform`, `channel`, `status` (per-channel statuses such as `scheduled`, `overdue`, `published`), a range `from`/`to`, or `unscheduled: true`. Pages with `limit` (at most 100) and `next_cursor`.

### get_post
One post: fields, `body`, per-channel `channels` (status, time, live link, error, `frozen` for an entry the plugin can't read), `issues`, `blocking`, `counters` (length per part against the limit), `thread_items`, `review: "claude"` when written offline.

### get_platform_rules
The limits the plugin checks per platform: characters and how they are counted, fold, title, link, hashtags, media, threads (`a line containing only ---`), text format. Read before drafting.

### get_log
The last lines of the publish log (`Social/_log.md`): time · channel · post · result · link or error. `limit`, `contains`, `month` (an archive, `YYYY-MM`).

## Write

### create_campaign
`title`, `anchor_date`, `link`, `brief`, `idempotency_key`. Creates `Social/<Title>/<Title>.md` with the brief and the variants table.

### create_variant
`platform`, `campaign` (its path; or leave out and give `title` for a standalone post), `channels`, `body`, `title`, `url`, `media` (vault image names), `mode`, `scheduled_at` (a proposed time only), `reminders`, `wordpress` (`slug`, `excerpt`, `categories`, `tags`, `featured_image`), `force_draft`, `idempotency_key`. Always a draft. Checked first: on a blocking issue nothing is written unless `force_draft`. Unknown channels always block. Use a fresh `idempotency_key` per post and reuse it only to retry that post.

### update_variant
`path` plus any of `title` (`null` removes it), `url` (`null` removes it), `body` (the whole new body), `channels` (the complete new list), `mode`, `reminders`, `stagger_minutes`, `media`, `wordpress`, `force_draft`. Checked first. Channels that were published, handed over or wait for the user stay. `force_draft` is refused on a scheduled post. Editing never changes what is already live: see `push_update`.

### fork_variant
`path`, `channel`: moves one channel into its own note with a copy of the text, for a page that needs different wording.

### validate
Either `path` (an existing post) or `draft` (`platform`, `channels`, `title`, `url`, `body`, `media`, `wordpress`). Returns `issues`, `blocking` and `counters` without writing. Use it before `create_variant`.

## Schedule

### schedule
`path`, `at`, `reminders` (minutes before), `move_awaiting`. Makes the post go out at `at` on all its channels (staggered). Refused for a time in the past (`past-time`), blocking issues, channels already handed over to the platform, and channels waiting for the user unless `move_awaiting: true` (the answer then has `needs_confirmation: "move_awaiting"`: ask the user first). Only after the user agreed.

### unschedule
`path`, `to` (`draft` or `ready`). Refused when a channel was handed over, published or waits for the user.

### find_free_slots
`channels`, `from`, `to` (at most 62 days), `min_spacing_minutes` (default 180), `preferred_windows` (`days` 0 = Sunday … 6 = Saturday, `start`, `end` as HH:mm), `step_minutes`, `per_channel`. Free times per channel, away from everything already planned there, closest to the channel's usual time first. Deterministic.

## Publish (asks the user in Obsidian)

### publish_now
`path`, `channels` (optional subset), `note` (one sentence for the user). Only when the user asked to publish now. Obsidian shows the text, the channels and "now" and asks Approve or Deny; no answer within 2 minutes is a no, and so is a second request while one is open. API channels post from the publisher device; the others open the assisted flow in Obsidian for the user. If the post changed after approval, nothing is sent. Answers `approved`, `started_api`, `opened_assisted`, or the reason it was not sent.

### push_update
`path`, `channels`, `note`. Sends the current text to channels where the post is already live, where the platform supports updates, after the same approval.
```

- [ ] **Step 4: Write the file-format reference**

`claude-plugin/skills/social/references/file-format.md`:
`````markdown
# Note format for offline mode

Use this only when the Social Planner MCP tools are not available (Obsidian is closed or the server is off). You write Markdown files directly. The plugin checks them the next time Obsidian opens and lists them under **Written by Claude** in its sidebar; nothing you write this way is posted or reminded about until the user approves it there.

## Where things are
- Vault root: the folder that contains `.obsidian/`. Claude Code must run there.
- Settings, read only (never edit): `.obsidian/plugins/osmm-social-planner/data.json`. `rootFolder` is the social folder (default `Social`), `channels` lists the channels (`id`, `platform`, `name`, `method`) and `channelGroups` the groups. It holds no secrets.
- Campaign: `<root>/<Campaign>/<Campaign>.md`.
- Post of a campaign: `<root>/<Campaign>/<Campaign> – <Platform>.md` (space, en dash, space; the platform's label, e.g. `Hacker News`). If the file exists, add ` 2`, ` 3`, …
- Standalone post: `<root>/Posts/<Title>.md`.
- Voice profile: `<root>/_voice.md`. Publish log (read only): `<root>/_log.md`.
- File names: none of `\ / : * ? " < > | # ^ [ ]`, at most 120 characters.

## Rules
1. Every post you write has `status: ready` and `review: claude`. Never write `status: scheduled`, never a `deliveries:` map, and never touch `review` on a note you didn't write.
2. `scheduled_at` is the proposed time, ISO 8601 with the offset: `2026-10-08T17:30:00+02:00`.
3. `channels` is a YAML list of channel ids of the note's platform, from data.json.
4. Don't edit a note that has `deliveries:` (it is already scheduled or published); tell the user what to change instead.
5. Keep within the platform's limits (see the playbooks); the plugin checks again.
6. Tell the user which files you wrote and that they approve them in Obsidian (sidebar, **Written by Claude**, **Approve & schedule**).

## Fields
| Field | Notes |
|---|---|
| `type` | `social-campaign` or `social-post` |
| `campaign` | `"[[<Campaign>]]"` (quoted wikilink); leave out for a standalone post |
| `platform` | `linkedin`, `x`, `instagram`, `facebook`, `mastodon`, `bluesky`, `telegram`, `discord`, `hackernews`, `indiehackers`, `reddit`, `whatsapp`, `wordpress` |
| `title` | required for standalone posts, Hacker News, Reddit, Indie Hackers and WordPress |
| `url` | http(s) link for link submissions and link cards |
| `channels` | list of channel ids, e.g. `[li/acme-studio, li/maker-lab]` |
| `mode` | `auto` (post by API where possible) or `assisted` (always remind) |
| `status` | always `ready` in offline mode |
| `review` | always `claude` in offline mode |
| `scheduled_at` | proposed time with offset |
| `stagger_minutes` | minutes between channels (optional) |
| `reminders` | minutes before, e.g. `[60, 10]` (optional) |
| `media` | list of quoted wikilinks to vault images, e.g. `["[[event-x-cover.png]]"]` |
| `slug`, `excerpt`, `categories`, `tags`, `featured_image` | WordPress only; `featured_image: "[[cover.png]]"` |

The body is the post. On X, Mastodon and Bluesky, a line with only `---` starts the next post of a thread.

## Campaign

````markdown
---
type: social-campaign
title: Event X
anchor_date: 2026-10-12T18:00:00+02:00
link: https://example.com/event-x
status: active
---

## Brief

A free evening for makers in Berlin, 80 seats. Goal: 60 sign-ups by 10 October.

## Variants

```social-variants
```
````

## LinkedIn post for two company pages

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: linkedin
channels:
  - li/acme-studio
  - li/maker-lab
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-05T09:00:00+02:00
reminders: [60, 10]
---
I almost didn't host Event X again.

Six months ago twelve makers came to the first one. On the 12th, eighty are coming.

If you build things on your own, come and meet the people who do the same. Free, 18:00, Berlin.
````

## X thread

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: x
channels: [x/you]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-06T12:00:00+02:00
---
I almost didn't host Event X again.
---
Six months ago, twelve makers showed up. On the 12th, eighty are coming.
---
Free, 18:00, Berlin. Sign up: https://example.com/event-x
````

## WordPress article

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: wordpress
title: Event X is back on 12 October
slug: event-x-is-back
excerpt: A free evening for 80 makers in Berlin.
categories: [Community]
tags: [events, makers]
channels: [wp/eventx-berlin]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-07T08:00:00+02:00
---
# Event X is back

Six months ago, twelve makers met in a back room to show what they were building. On 12 October we do it again, with eighty.

## What happens

- 18:00 doors open
- 18:30 five short demos
- 19:30 open tables
````

## Standalone Mastodon post

````markdown
---
type: social-post
platform: mastodon
title: Weekly devlog 13
channels: [ma/you]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-09T09:00:00+02:00
---
Devlog 13: the calendar learned to talk to Claude Code.
````
`````

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/claude && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude-plugin/skills/social/references test/claude/references.test.ts
git commit -m "docs(claude): MCP tool reference and the offline note format, checked against the code (#81, #84)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Platform playbooks (#82)

**Files:**
- Create: `claude-plugin/skills/social/references/platforms/{linkedin,x,instagram,facebook,mastodon,bluesky,telegram,discord,hackernews,indiehackers,reddit,whatsapp,wordpress}.md`, `test/claude/playbooks.test.ts`

**Interfaces:**
- Consumes: `PLATFORMS`, `PLATFORM_META` (`src/model/platforms.ts`), `PLATFORM_DEFS` (`src/platforms/registry.ts`), `fmt` (`src/platforms/checks.ts`).
- Produces: one playbook per platform, starting with `# <Label>`, stating the numbers the plugin checks in fixed phrases the test looks for: `Hard limit: N characters`, `folds after about N characters`, `Title: at most N characters`, `at most N hashtags`, `N characters when an image is attached`, `a line with only ---` (thread platforms) and `needs at least one image` (Instagram). Sections: Format, Tone, Length, Hashtags, Links, Structure, Checklist. Loaded on demand from SKILL.md (progressive disclosure).

- [ ] **Step 1: Write the failing test**

`test/claude/playbooks.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORM_META, PLATFORMS } from "../../src/model/platforms";
import { fmt } from "../../src/platforms/checks";
import { PLATFORM_DEFS } from "../../src/platforms/registry";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../claude-plugin/skills/social/references/platforms/${p}.md`, import.meta.url)), "utf8");

describe.each([...PLATFORMS])("%s playbook (#82)", (p) => {
  it("states the limits the plugin checks, with no emoji", () => {
    const text = read(p);
    const { limits, media, threads } = PLATFORM_DEFS[p].capabilities;
    expect(text.startsWith(`# ${PLATFORM_META[p].label}\n`)).toBe(true);
    expect(text).toContain(`Hard limit: ${fmt(limits.maxChars)} characters`);
    if (limits.foldAt) expect(text).toContain(`folds after about ${fmt(limits.foldAt)} characters`);
    if (limits.titleMax) expect(text).toContain(`Title: at most ${fmt(limits.titleMax)} characters`);
    if (limits.maxHashtags) expect(text).toContain(`at most ${limits.maxHashtags} hashtags`);
    if (limits.maxCharsWithMedia) expect(text).toContain(`${fmt(limits.maxCharsWithMedia)} characters when an image is attached`);
    if (threads) expect(text).toContain("a line with only ---");
    if (media.required) expect(text).toContain("needs at least one image");
    for (const section of ["## Format", "## Tone", "## Length", "## Hashtags", "## Links", "## Structure", "## Checklist"]) expect(text).toContain(section);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/claude/playbooks.test.ts`
Expected: FAIL — `ENOENT … platforms/linkedin.md`.

- [ ] **Step 3: Write the playbooks**

`claude-plugin/skills/social/references/platforms/linkedin.md`:
```markdown
# LinkedIn

Hard limit: 3,000 characters. The feed folds after about 210 characters, so the first two lines must earn the click on "see more".

## Format
Plain text: no Markdown, no bold. Short paragraphs separated by a blank line. Posting as a company page and as a person reads differently: pages speak as "we", profiles as "I".

## Tone
Professional but human. A concrete story or result beats an announcement. No hype ("thrilled to announce", "game-changer").

## Length
Sweet spot 700–1,300 characters. One idea per post. A one-line hook, three to six short paragraphs, one clear ask.

## Hashtags
Zero to three, at the end, specific (#BerlinTech rather than #Tech).

## Links
Links in the text reduce reach; the plugin warns about them. Prefer "link in the first comment" and tell the user to add it after posting, unless the user wants the link in the post.

## Structure
A hook line, then the context, then the concrete thing (numbers, names, what changed), then what the reader should do.

## Checklist
- The first 210 characters work on their own.
- Page variants differ from the personal one (fork_variant when a page needs its own text).
- One call to action.
```

`claude-plugin/skills/social/references/platforms/x.md`:
```markdown
# X

Hard limit: 280 characters per post. X weighs characters: most Latin letters count 1, emoji and CJK count 2, and every link counts 23 whatever its length.

## Format
Plain text. For a thread, a line with only --- starts the next post; each part has its own 280 limit. Up to 4 images per post.

## Tone
Direct, conversational, specific. Cut filler words first when trimming.

## Length
Single posts: 120–240 characters. Threads: 3–6 parts; the first part must stand alone.

## Hashtags
At most one, only if it is a real conversation (#buildinpublic); none is fine.

## Links
Put the link in the last part of a thread, or in a single post's last line. It counts 23 characters.

## Structure
Part 1: the hook and the promise. Middle parts: one point each. Last part: the link and the ask.

## Checklist
- Every part fits 280 (check the counters from validate).
- Part 1 makes sense without the rest.
- No part ends mid-sentence.
```

`claude-plugin/skills/social/references/platforms/instagram.md`:
```markdown
# Instagram

Hard limit: 2,200 characters in the caption. The caption folds after about 125 characters. A post needs at least one image (up to 10, aspect ratio between 4:5 and 1.91:1).

## Format
Plain text caption under an image or a carousel. Line breaks are kept. Add alt text to every image (media_meta alt).

## Tone
Visual and personal; the caption supports the picture rather than describing it.

## Length
125–400 characters for most posts; longer only for stories people want to read.

## Hashtags
Instagram allows at most 30 hashtags; use 3–8 relevant ones at the end or in a separate paragraph.

## Links
Captions have no clickable link. Say "link in bio" and tell the user to update the bio link.

## Structure
First line: the hook, visible before the fold. Then the story or details. Then the ask and the hashtags.

## Checklist
- An image is attached and has alt text.
- The first 125 characters carry the message.
- No URL in the caption.
```

`claude-plugin/skills/social/references/platforms/facebook.md`:
```markdown
# Facebook

Hard limit: 63,206 characters. The feed folds after about 480 characters.

## Format
Plain text on a page. Up to 10 images. Line breaks are kept.

## Tone
Friendly and local; pages that sound like a person get more replies.

## Length
40–250 characters for reach; up to about 480 before the fold for a fuller update.

## Hashtags
Zero to two; they matter little here.

## Links
A link in the text shows a preview card. Keep the text short when a card carries the details.

## Structure
The news in the first sentence, the practical details next (date, time, place, price), then the ask.

## Checklist
- The key facts are before the fold.
- Event details are complete and match the campaign.
```

`claude-plugin/skills/social/references/platforms/mastodon.md`:
```markdown
# Mastodon

Hard limit: 500 characters per post on most servers; some servers allow more, and the channel's own limit (list_channels max_chars) wins. Every link counts 23 characters; a mention like @user@server counts as @user.

## Format
Plain text. For a thread, a line with only --- starts the next post. Up to 4 images, each with alt text: people here expect it.

## Tone
Conversational, no marketing voice. Content warnings are used for sensitive topics.

## Length
200–450 characters; threads of 2–4 posts for longer stories.

## Hashtags
Two to four in CamelCase (#OpenSource, #BerlinEvents): hashtags are how people find posts here, and CamelCase helps screen readers.

## Links
Links are fine and don't hurt reach.

## Structure
Say the thing in the first sentence; add context; end with the link.

## Checklist
- Every image has alt text.
- Hashtags are CamelCase.
- Each part fits the channel's limit.
```

`claude-plugin/skills/social/references/platforms/bluesky.md`:
```markdown
# Bluesky

Hard limit: 300 characters per post. For a thread, a line with only --- starts the next post.

## Format
Plain text. Up to 4 images (about 1 MB each). A post shows either images or a link card, not both; the plugin warns when both are set.

## Tone
Casual and direct, similar to early Twitter.

## Length
150–280 characters; threads of 2–4 posts.

## Hashtags
Zero to two; custom feeds matter more than hashtags.

## Links
A link shows a card when there is no image. Put the link in the post that should carry the card.

## Structure
Hook and news first; details in the next post of the thread; the link last.

## Checklist
- Every part fits 300.
- Images or a link card, not both.
```

`claude-plugin/skills/social/references/platforms/telegram.md`:
```markdown
# Telegram

Hard limit: 4,096 characters for a text message, and 1,024 characters when an image is attached (the image caption).

## Format
Channel posts support bold, italic, links and code; the plugin converts the note's Markdown. Up to 10 images as an album.

## Tone
Newsletter-like and to the point: subscribers chose to follow.

## Length
300–1,000 characters; stay under 1,024 when there is an image.

## Hashtags
Rarely used; one topic tag at most.

## Links
Links are fine; the first link gets a preview unless an image is attached.

## Structure
A bold first line with the news, the details as a short list, the link last.

## Checklist
- With an image, the text fits 1,024.
- The bold first line works as a headline.
```

`claude-plugin/skills/social/references/platforms/discord.md`:
```markdown
# Discord

Hard limit: 2,000 characters per message.

## Format
Discord Markdown: **bold**, *italic*, lists, `code`. Up to 10 attachments. Mentions such as @everyone ping the whole server: use them only when the user asked.

## Tone
Community voice, as a member talking to the server.

## Length
200–800 characters.

## Hashtags
None; Discord doesn't use them.

## Links
Links are fine and show an embed.

## Structure
One-line headline in bold, the details as a short list, the link and the ask.

## Checklist
- No @everyone or @here unless the user asked for it.
- The message fits 2,000.
```

`claude-plugin/skills/social/references/platforms/hackernews.md`:
```markdown
# Hacker News

Hard limit: 4,000 characters for the text of a text post. Title: at most 80 characters. A submission needs a link (url) or a text; no images.

## Format
Title plus either a URL or a plain-text body. "Show HN:" titles are for things people can try. The plugin opens the pre-filled submit page; the user submits by hand.

## Tone
Plain, factual, modest. No marketing words, no exclamation marks, no emoji. Readers punish hype.

## Length
Titles of 40–80 characters. Show HN text: 3–8 short paragraphs about what it is, why, how it works and what is missing.

## Hashtags
None.

## Links
The url field is the submission link. In a text post, links are plain text.

## Structure
Title: what it is, in the product's own words ("Show HN: OSMM – plan social posts in Obsidian"). Text: the problem, what you built, the technical interesting part, what you want feedback on.

## Checklist
- The title fits 80 and has no clickbait.
- Either url or text, as the post needs.
- Nothing promotional in the text.
```

`claude-plugin/skills/social/references/platforms/indiehackers.md`:
```markdown
# Indie Hackers

Hard limit: 40,000 characters. Title: at most 150 characters.

## Format
Markdown post with a title, in a group. The plugin opens the page and puts the text on the clipboard.

## Tone
Open, founder to founder: numbers, lessons and mistakes.

## Length
1,500–5,000 characters for a milestone or lessons post.

## Hashtags
None.

## Links
One link to the product is expected; more reads as promotion.

## Structure
Title with the result or lesson ("From 0 to 80 attendees in six months"). Context, what worked, what didn't, numbers, a question for the readers.

## Checklist
- The title fits 150 and promises something specific.
- Real numbers, no invented ones.
- Ends with a question to start the discussion.
```

`claude-plugin/skills/social/references/platforms/reddit.md`:
```markdown
# Reddit

Hard limit: 40,000 characters for a text post. Title: at most 300 characters. A post needs a link (url) or a text. The channel's handle must be the subreddit (r/SideProject); the plugin blocks the post otherwise.

## Format
Title plus a Markdown body or a link. Each subreddit has its own rules on self-promotion: tell the user to check them.

## Tone
Community member, not brand. Give value first; mention your own project only where the subreddit allows it.

## Length
Titles of 60–120 characters. Bodies of 500–2,000 characters.

## Hashtags
None.

## Links
A link post or one link in the text; several links look like spam.

## Structure
A title that states the useful thing. Body: context, the details, what you learned, an honest question.

## Checklist
- The channel handle is the subreddit.
- The title fits 300 and follows the subreddit's style.
- Not written as an ad.
```

`claude-plugin/skills/social/references/platforms/whatsapp.md`:
```markdown
# WhatsApp

Hard limit: 65,536 characters.

## Format
WhatsApp formatting: *bold*, _italic_; the plugin converts the note's Markdown. The user pastes the message into the group.

## Tone
Personal, like writing to people you know. Groups dislike broadcast messages.

## Length
150–500 characters.

## Hashtags
None.

## Links
One link, on its own line so the preview works.

## Structure
The news in bold on the first line, the practical details, the link.

## Checklist
- Short enough to read on a phone without scrolling.
- One link at most.
```

`claude-plugin/skills/social/references/platforms/wordpress.md`:
```markdown
# WordPress

Hard limit: 1,000,000 characters (the plugin's sanity cap; the site decides). A title is required, and so is a slug.

## Format
The note's body is the article in Markdown; the plugin converts it to HTML and uploads local images. Frontmatter: `title`, `slug` (lowercase letters, digits and dashes), `excerpt` (the SEO description), `categories`, `tags`, `featured_image`.

## Tone
Follow the site's voice from the voice profile; articles can be more complete than posts.

## Length
600–1,500 words for an announcement or recap; an excerpt of 120–160 characters.

## Hashtags
None; use `tags` and `categories` instead, reusing existing ones where the user named them.

## Links
Descriptive link text ("the Event X programme"), not "click here".

## Structure
H1 is the title; short intro with the key facts; H2 sections; a closing call to action. Then write the social posts that point to the article ("Generate social variants from article" in the plugin, or create_variant per platform with the article's link as url).

## Checklist
- slug set, lowercase with dashes.
- excerpt of 120–160 characters.
- A featured image is set, or the user knows there is none.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/claude/playbooks.test.ts`
Expected: PASS (13 platforms). If a number in `src/platforms/*/index.ts` changed since this plan was written, update the playbook sentence, not the test.

- [ ] **Step 5: Commit**

```bash
git add claude-plugin/skills/social/references/platforms test/claude/playbooks.test.ts
git commit -m "docs(claude): platform playbooks for the /social skill, limits checked against the plugin (#82)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Voice profile, review page and the last skill references (#83, #85)

**Files:**
- Create: `src/claude/voice.ts`, `src/mcp/tools/voice.ts`, `claude-plugin/skills/social/references/voice.md`, `claude-plugin/skills/social/references/review-page.md`, `test/mcp/voice.test.ts`
- Modify: `src/main.ts` (`openVoiceProfile`), `src/commands.ts`, `src/settings/tab.ts` ("Voice profile"), `src/mcp/index.ts`, `claude-plugin/skills/social/references/tools.md`, `test/claude/references.test.ts`, `test/main.test.ts`, `test/commands.test.ts` (if it lists command ids)

**Interfaces:**
- Consumes: `SafeWriter.editBody` (Task 5); `McpToolDeps`, `clip`, `claudeNotice`, `normalizePathArg`, `zPath` (Task 4); `formatDateTime`.
- Produces:
  - `VOICE_FILE = "_voice.md"`, `VOICE_TEMPLATE: string`, `voicePath(root): string`, `createVoiceProfile(app, root): Promise<{ file: TFile; created: boolean }>` (never overwrites).
  - `OsmmPlugin.openVoiceProfile(): Promise<void>`; command `create-voice-profile` "Create voice profile"; a "Voice profile" setting (Create / Open) under "About Claude Code" (desktop section).
  - Tools `get_voice_profile {}` → `{ path, exists, text }` or `{ path, exists: false, template, hint }`; `add_voice_refinement { text }` (appends a dated `### YYYY-MM-DD` entry under `## Refinements`, never rewrites); `append_to_campaign { path, heading, text }` (appends a `## <heading>` section to a campaign note: review decisions, #85).
  - `references/voice.md` (the template, identical to `VOICE_TEMPLATE`, and the refine flow), `references/review-page.md` (#85). `tools.md` documents the three new tools.

- [ ] **Step 1: Write the failing tests**

`test/mcp/voice.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createVoiceProfile, VOICE_TEMPLATE } from "../../src/claude/voice";
import { mcpCtx } from "./helpers";

describe("voice profile tools (#83)", () => {
  it("returns the template and a hint when there is no profile yet", async () => {
    const c = await mcpCtx();
    const r = await c.call("get_voice_profile");
    expect(r).toMatchObject({ ok: true, path: "Social/_voice.md", exists: false, template: VOICE_TEMPLATE });
    expect(r.hint).toContain("Create voice profile");
    expect((await c.call("add_voice_refinement", { text: "Shorter hooks." })).error).toContain("Create voice profile");
  });

  it("reads the profile and appends dated refinements without rewriting it", async () => {
    const c = await mcpCtx();
    const { created } = await createVoiceProfile(c.app as never, "Social");
    expect(created).toBe(true);
    expect((await createVoiceProfile(c.app as never, "Social")).created).toBe(false);
    expect((await c.call("get_voice_profile")).text).toBe(VOICE_TEMPLATE);
    expect((await c.call("add_voice_refinement", { text: "- Posts that open with a number did best on LinkedIn." })).ok).toBe(true);
    const text = await c.app.vault.read(c.app.vault.getFileByPath("Social/_voice.md")!);
    expect(text.startsWith(VOICE_TEMPLATE.trimEnd())).toBe(true);
    expect(text.endsWith("### 2026-10-08\n\n- Posts that open with a number did best on LinkedIn.\n")).toBe(true);
  });

  it("appends review decisions to a campaign note (#85)", async () => {
    const c = await mcpCtx();
    const r = await c.call("append_to_campaign", { path: "Social/Event X/Event X.md", heading: "Review decisions (2026-10-08)\n# injected", text: "- LinkedIn: approved.\n- X: shorten part 2." });
    expect(r.ok).toBe(true);
    const text = await c.app.vault.read(c.app.vault.getFileByPath("Social/Event X/Event X.md")!);
    expect(text).toContain("```social-variants\n```");
    expect(text.endsWith("## Review decisions (2026-10-08) injected\n\n- LinkedIn: approved.\n- X: shorten part 2.\n")).toBe(true);
    expect((await c.call("append_to_campaign", { path: "Social/Nope.md", heading: "x", text: "y" })).error).toContain("list_campaigns");
  });
});
```

Add to `test/claude/references.test.ts`:
```ts
import { readdirSync, statSync } from "node:fs";
import { VOICE_TEMPLATE } from "../../src/claude/voice";

const SKILL = fileURLToPath(new URL("../../claude-plugin/skills/social/", import.meta.url));

function files(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  });
}

describe("SKILL.md links (#82)", () => {
  it("links every reference file, and every link resolves", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
    const all = files(SKILL, "references");
    expect([...new Set(links)].sort()).toEqual(all.sort());
  });

  it("ships the same voice template as the plugin's Create voice profile command (#83)", () => {
    const block = /^````markdown\n([\s\S]*?)^````$/m.exec(read("voice.md"))![1];
    expect(block).toBe(VOICE_TEMPLATE);
  });
});
```
(Merge the imports into the file's existing import lines.)

Add to `test/main.test.ts` (inside `describe("OsmmPlugin", …)`):
```ts
  it("creates the voice profile once and opens it (#83)", async () => {
    const { app, plugin } = await loaded();
    const command = (plugin as unknown as { commands: Array<{ id: string; callback?: () => unknown }> }).commands.find((c) => c.id === "create-voice-profile")!;
    await command.callback!();
    await settle();
    const file = app.vault.getFileByPath("Social/_voice.md")!;
    expect(await app.vault.read(file)).toContain("# Voice profile");
    expect(Notice.messages).toContain("Voice profile created. Fill it in; Claude reads it before drafting.");
    await app.vault.modify(file, "# Voice profile\n\nMine.\n");
    await command.callback!();
    await settle();
    expect(await app.vault.read(file)).toBe("# Voice profile\n\nMine.\n");
    expect(Notice.messages.at(-1)).toBe("Opened your voice profile.");
    plugin.unload();
  });
```
In "renders the General settings and applies edits", insert `"Voice profile",` after `"About Claude Code",`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mcp/voice.test.ts test/claude test/main.test.ts`
Expected: FAIL — `Cannot find module '../../src/claude/voice'`; unknown tools.

- [ ] **Step 3: Write the voice profile module**

`src/claude/voice.ts`:
```ts
import { normalizePath, type App, type TFile } from "obsidian";

/** The user's voice profile (spec §2.5), read by the /social skill before drafting. */
export const VOICE_FILE = "_voice.md";

export const VOICE_TEMPLATE = `# Voice profile

Claude reads this note before drafting posts (the /social skill). Keep it short and concrete, and replace the examples in brackets with your own.

## Who I am and who I write for
- I am: [one line: your role, your project, what you make]
- Audience: [who reads you and what they care about]

## Tone
- [e.g. Direct and warm. Short sentences. First person.]

## Do
- [e.g. Lead with the concrete result or number.]
- [e.g. One idea per post.]

## Don't
- [e.g. No hype words: "game-changer", "revolutionary", "excited to announce".]
- [e.g. At most two hashtags.]

## Vocabulary
- Words I use: [ ]
- Words I avoid: [ ]
- Spelling and style: [e.g. British English, sentence-case headings, numerals for 10 and up]

## Per platform
- LinkedIn: [ ]
- X: [ ]
- Mastodon and Bluesky: [ ]

## Example posts
Paste two to five posts that sound like you, each under its own heading.

### Example 1
[post text]

## Refinements
Claude adds dated notes here when you ask it to learn from your published posts. Edit or delete them freely.
`;

export function voicePath(root: string): string {
  return normalizePath(`${root}/${VOICE_FILE}`);
}

/** Creates `<root>/_voice.md` from the template unless it exists; never overwrites the user's profile. */
export async function createVoiceProfile(app: App, root: string): Promise<{ file: TFile; created: boolean }> {
  const path = voicePath(root);
  const existing = app.vault.getFileByPath(path);
  if (existing) return { file: existing, created: false };
  const folder = normalizePath(root);
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  return { file: await app.vault.create(path, VOICE_TEMPLATE), created: true };
}
```

- [ ] **Step 4: Command, setting and plugin method**

In `src/main.ts` (import `createVoiceProfile` from `./claude/voice`):
```ts
  /** Command "Create voice profile" (#83): creates Social/_voice.md from the template if needed, then opens it. */
  async openVoiceProfile(): Promise<void> {
    const { file, created } = await createVoiceProfile(this.app, this.settings.rootFolder);
    new Notice(created ? "Voice profile created. Fill it in; Claude reads it before drafting." : "Opened your voice profile.");
    await this.app.workspace.getLeaf(false).openFile(file);
  }
```
In `src/commands.ts`, append:
```ts
  plugin.addCommand({ id: "create-voice-profile", name: "Create voice profile", callback: () => plugin.openVoiceProfile() });
```
(If `test/commands.test.ts` lists every command id, add `create-voice-profile` to it.)

In `src/settings/tab.ts` `claudeSection`, right after the "About Claude Code" setting (import `voicePath` from `../claude/voice`):
```ts
    const hasVoice = !!this.app.vault.getFileByPath(voicePath(osmm.settings.rootFolder));
    new Setting(containerEl)
      .setName("Voice profile")
      .setDesc("Social/_voice.md: your tone, dos and don'ts and example posts. Claude reads it before drafting and cites it.")
      .addButton((b) => b.setButtonText(hasVoice ? "Open" : "Create").onClick(() => osmm.openVoiceProfile()));
```

- [ ] **Step 5: Write the tools**

`src/mcp/tools/voice.ts`:
```ts
import { z } from "zod";
import { voicePath, VOICE_TEMPLATE } from "../../claude/voice";
import { formatDateTime } from "../../model/dates";
import { claudeNotice, clip, normalizePathArg, zPath } from "../common";
import type { McpToolDeps } from "../deps";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const NO_PROFILE = 'There is no voice profile yet. Ask the user to run "Create voice profile" in Obsidian (command palette), then fill it in together.';

/** One line, no Markdown heading marks: the heading can't start a new section of its own. */
function heading(text: string): string {
  return text.replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").trim();
}

export function registerVoiceTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const today = () => formatDateTime(deps.now()).slice(0, 10);

  registry.add(
    defineTool({
      name: "get_voice_profile",
      title: "Get the voice profile",
      description: "The user's voice profile (Social/_voice.md): tone, dos and don'ts, vocabulary, example posts, refinements. Read it before drafting and say which rules you applied.",
      input: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => {
        const path = voicePath(deps.settings().rootFolder);
        const file = deps.app.vault.getFileByPath(path);
        if (!file) return ok({ path, exists: false, template: VOICE_TEMPLATE, hint: NO_PROFILE });
        return ok({ path, exists: true, text: clip(await deps.app.vault.cachedRead(file), 30_000) });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "add_voice_refinement",
      title: "Add to the voice profile",
      description:
        "Appends a dated entry under Refinements in the voice profile (never rewrites what the user wrote). Only after the user agreed to the exact text, e.g. rules learned from their best published posts.",
      input: z.object({ text: z.string().trim().min(1).max(4_000).describe("Markdown, usually a short list of concrete rules") }).strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async ({ text }) => {
        const path = voicePath(deps.settings().rootFolder);
        const file = deps.app.vault.getFileByPath(path);
        if (!file) return fail(NO_PROFILE);
        const entry = `### ${today()}\n\n${text}\n`;
        await deps.writer.editBody(file, (body) => {
          const base = body.trimEnd();
          return base.includes("## Refinements") ? `${base}\n\n${entry}` : `${base}\n\n## Refinements\n\n${entry}`;
        });
        claudeNotice(deps, "Claude added a refinement to your voice profile.", path);
        return ok({ path });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "append_to_campaign",
      title: "Append to a campaign note",
      description:
        "Adds a section at the end of a campaign note, e.g. the decisions from a review page (heading \"Review decisions (date)\"). Never changes the existing text or the frontmatter.",
      input: z
        .object({
          path: zPath,
          heading: z.string().trim().min(1).max(120),
          text: z.string().trim().min(1).max(20_000),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (a) => {
        const campaign = deps.index.getCampaign(normalizePathArg(a.path));
        if (!campaign) return fail(`No campaign note at "${a.path}". Use list_campaigns to find the path.`);
        const title = heading(a.heading);
        if (!title) return fail("The heading is empty.");
        await deps.writer.editBody(campaign.file, (body) => `${body.trimEnd()}\n\n## ${title}\n\n${a.text}\n`);
        claudeNotice(deps, `Claude added "${title}" to ${campaign.title}.`, campaign.path);
        return ok({ path: campaign.path });
      },
    }),
  );
}
```
Wire it: in `src/mcp/index.ts` add `import { registerVoiceTools } from "./tools/voice";` and `registerVoiceTools(registry, deps);`.

Append to `claude-plugin/skills/social/references/tools.md`:
```markdown
## Voice and notes

### get_voice_profile
The voice profile (`Social/_voice.md`) as text, or `exists: false` with the template and a hint. Read it before drafting.

### add_voice_refinement
`text`: appends a dated entry under Refinements. Only after the user agreed to the exact text.

### append_to_campaign
`path`, `heading`, `text`: adds a section at the end of a campaign note, e.g. "Review decisions (2026-10-08)". Never changes existing text.
```

- [ ] **Step 6: Write the voice and review references**

`claude-plugin/skills/social/references/voice.md` — the four-backtick block must contain `VOICE_TEMPLATE` exactly (the test compares them; copy it from `src/claude/voice.ts` including the final newline before the closing fence):
`````markdown
# Voice profile

The user's voice lives in `Social/_voice.md` (`get_voice_profile`). Read it before drafting and, with each draft, name the rules you applied ("Voice: no hype words, first person, one idea per post").

## When there is none
Offer to create it: the user runs **Create voice profile** in Obsidian (command palette, or Settings → Social Planner → Claude Code → Voice profile), which writes this template. Then fill it in together: ask about audience, tone, words they like and avoid, and ask for two to five posts they are proud of. Offline, write the file yourself from the template.

## Template

````markdown
# Voice profile

Claude reads this note before drafting posts (the /social skill). Keep it short and concrete, and replace the examples in brackets with your own.

## Who I am and who I write for
- I am: [one line: your role, your project, what you make]
- Audience: [who reads you and what they care about]

## Tone
- [e.g. Direct and warm. Short sentences. First person.]

## Do
- [e.g. Lead with the concrete result or number.]
- [e.g. One idea per post.]

## Don't
- [e.g. No hype words: "game-changer", "revolutionary", "excited to announce".]
- [e.g. At most two hashtags.]

## Vocabulary
- Words I use: [ ]
- Words I avoid: [ ]
- Spelling and style: [e.g. British English, sentence-case headings, numerals for 10 and up]

## Per platform
- LinkedIn: [ ]
- X: [ ]
- Mastodon and Bluesky: [ ]

## Example posts
Paste two to five posts that sound like you, each under its own heading.

### Example 1
[post text]

## Refinements
Claude adds dated notes here when you ask it to learn from your published posts. Edit or delete them freely.
````

## Refining the voice from published posts
1. `list_posts` with `status: ["published"]` (per platform if the user wants), then `get_post` for up to ten of them; `get_log` shows which went out and where.
2. Compare them with the profile: what do the posts that worked have in common (openings, length, structure, words)? What contradicts the profile?
3. Propose three to five concrete rules, each with the post that shows it. No vague rules ("be engaging").
4. Only after the user agrees to the exact wording, `add_voice_refinement` with those rules as a list. Never rewrite the user's own sections; suggest edits and let them make them.
`````

`claude-plugin/skills/social/references/review-page.md`:
```markdown
# Campaign review page (optional)

Use when the user wants to share a campaign for sign-off before it is scheduled.

## Build the page
Make one self-contained HTML page (inline CSS, no scripts, no external fonts or trackers):
- Header: campaign title, anchor date, goal, link, and "Draft for review, <date>".
- Schedule table: date and time, platform, channels, status, one line per post, in time order.
- One card per post: platform and channels, time, the full text exactly as it will be posted (HTML-escaped; thread parts separated), title and link where the platform uses them, image names with their alt text, and any warnings from `validate`.
- A short "What we need from you" list: approve, or comment per post.

Never include tokens, the ntfy topic, file paths outside the vault or anything from `data.json` beyond channel names.

## Share it
If this Claude Code session has a tool to publish a private page or artifact, use it and give the user the link; keep it private unless the user says otherwise. Otherwise save it next to the campaign as `<Campaign> – review.html` and tell the user where it is. Say that the page is a snapshot: later edits in Obsidian don't update it.

## Record the decisions
When the user brings back comments or decisions, summarise them per post and, after the user confirms the summary, call `append_to_campaign` with the heading `Review decisions (<YYYY-MM-DD>)` and the summary as a list. Then apply the agreed changes with `update_variant` and show the new checks. Offline, append the same section to the campaign note yourself.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src claude-plugin test
git commit -m "feat(claude): voice profile command and template, voice and campaign tools, review page reference (#83, #85)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: Docs and M4 acceptance pass

**Files:**
- Create: `docs/qa/m4.md`
- Modify: `README.md`, `docs/getting-started.md`

**Interfaces:**
- Consumes: everything above. Docs describe only what Tasks 1–14 built (no future features stated as available).
- Produces: README "Claude Code" section and data notes, getting-started step 8, and the manual QA checklist with every **(QA)** item of this plan.

- [ ] **Step 1: Update the README**

In `README.md`, add to "What it does" (after the "Don't miss a post" bullet):
```markdown
- **Plan with Claude Code:** a local MCP server (desktop, off by default) lets Claude Code read your plan, draft posts in your voice, check them with the plugin's own rules, find free posting times and schedule them. It never publishes on its own: Obsidian asks you first. The `/osmm:social` skill (a Claude Code plugin in this repo) turns one conversation into a scheduled campaign, and still works when Obsidian is closed by writing notes you approve later.
```
Add a section before "Your data":
```markdown
## Claude Code

1. In Obsidian: **Settings → Social Planner → Claude Code**, turn on **MCP server on this device**, click **Copy setup command** and run it in a terminal. `claude mcp list` should show `osmm` as connected.
2. Install the skill: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`, then `claude plugin install osmm@osmm-social-planner`.
3. In Claude Code: `/osmm:social plan the launch of <your product> on LinkedIn, X and Mastodon for next week`.

Optional: run **Create voice profile** in Obsidian and fill in `Social/_voice.md`; Claude reads it before drafting. See [the getting-started guide](docs/getting-started.md#8-plan-a-campaign-with-claude-code-5-minutes-optional).
```
Add to "Your data":
```markdown
- The Claude Code server listens on 127.0.0.1 only and needs a token kept in this device's secret storage; requests from web pages are refused. Claude sees your posts, campaigns, channel names and the publish log, never credentials. Publishing from Claude always goes through an approval in Obsidian unless you allow a channel to skip it.
```

- [ ] **Step 2: Extend the getting-started guide**

Append to `docs/getting-started.md`, before "When something goes wrong":
```markdown
## 8. Plan a campaign with Claude Code (5 minutes, optional)

On a desktop:

1. Open **Settings → Social Planner → Claude Code** and turn on **MCP server on this device**. It listens on this computer only and uses a secret token.
2. Click **Copy setup command**, paste it into a terminal and run it. Then click **Test connection**: "The server answers" means Claude Code can connect. The command contains the token; don't share it. After **New token**, run the new command.
3. Install the skill in Claude Code: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`, then `claude plugin install osmm@osmm-social-planner`.
4. Optional but worth it: run **Create voice profile** and describe how you write; add two or three posts you like.
5. In Claude Code, type `/osmm:social` and what you want, for example "plan Event X for LinkedIn, X and Bluesky, the event is on the 12th". Claude proposes a plan, drafts each post, checks it and schedules it once you agree. Each change shows a notice in Obsidian with **Open**.

Claude never publishes by itself. If you ask it to post now, Obsidian shows what, where and when, with **Approve** and **Deny**; no answer within two minutes means no. Under **Publishing from Claude** you can let a channel skip that question.

If Obsidian is closed, run Claude Code inside your vault folder: the skill writes the notes directly, and the next time Obsidian opens they wait under **Written by Claude** in the sidebar until you click **Approve & schedule** (or **Keep as draft**). They are not posted or reminded about before that.
```

- [ ] **Step 3: Write the QA checklist**

`docs/qa/m4.md`:
```markdown
# M4 manual QA — Claude Code MCP server and the /social skill

Setup: `npm run seed && npm run dev`, open `dev-vault/` in Obsidian 1.11.4+ on a desktop, with the latest Claude Code in a terminal. Run in the dark and light themes.

## Connection (#73, #78)
- [ ] Fresh install: Settings → Claude Code shows the toggle off; `lsof -iTCP:27150` shows nothing.
- [ ] Turn it on: the sidebar light reads "Claude Code: ready on port 27150"; `lsof` shows it bound to 127.0.0.1 only.
- [ ] Copy setup command, run it, and follow it on the first try: `claude mcp list` shows `osmm` connected. **(QA)** If Claude Code rejects the flag order, record the working form and update `setupCommand()` and the docs.
- [ ] **(QA)** Protocol era: `claude --debug` shows an `initialize` with a 2025 protocol version and a `tools/list`. If it only sends `MCP-Protocol-Version: 2026-07-28` requests and gives up on the empty 400, open a follow-up to add the 2026-07-28 revision (ADR 0002).
- [ ] **(QA)** Wrong token: Claude Code reports an authentication error and does not loop on an OAuth flow; the settings show "Last refused request … (missing or wrong token)".
- [ ] `curl -i http://127.0.0.1:27150/mcp` → 401; with the token and `-H "Origin: https://example.com"` → 403; with `-H "Host: evil.example:27150"` → 403; with `-H "Content-Type: text/plain"` → 415; from another machine on the LAN the port is unreachable.
- [ ] Test connection, New token (the old command stops working at once), a port change with Apply; a port already in use shows "Port … is already in use".
- [ ] Disable and re-enable the plugin, and reload Obsidian, with the server on: it comes back on the same port.
- [ ] Check `data.json`, `localStorage` (devtools → Application) and the vault: the token appears nowhere.
- [ ] iPhone and Android: the plugin loads, the settings have no Claude Code section, the sidebar has no light.

## Tools (#74–#77)
- [ ] Ask Claude to list campaigns, show a post and read the log: answers match the planner.
- [ ] Ask Claude to create a campaign and three posts: notices "Claude created …" with Open; notes appear in the calendar; retrying a timed-out request does not create a second note.
- [ ] Ask for free slots next week on two channels: times are spread, inside 09:00–18:00, away from existing posts.
- [ ] Ask Claude to schedule a post: it appears as scheduled; a post with a channel awaiting you makes Claude ask before moving it.
- [ ] Ask Claude to publish a post now: the approval dialog shows the text, the channels and "now". Deny with a reason: Claude relays it. Leave it for two minutes: Claude reports no answer and nothing is posted. Approve an assisted post: the assisted flow opens.
- [ ] Edit the post while the approval dialog is open, then approve: nothing is sent and Claude is told the post changed.
- [ ] Allow a channel under Publishing from Claude (with confirmation): publish_now no longer asks for it.

## Skill (#79–#85)
- [ ] **(QA)** Fresh Claude Code: `claude plugin validate .` passes in the repo; `claude plugin marketplace add dannickstark/Obsidian-Social-media-management` and `claude plugin install osmm@osmm-social-planner` install cleanly; `/osmm:social` appears.
- [ ] Evaluate on three sample campaigns; every note written validates (no blocking issue in the composer) and appears in the calendar:
  1. "Event X", a monthly makers evening in Berlin on the 12th: LinkedIn (profile + two pages), X thread, Mastodon, Telegram, a WordPress recap.
  2. "OSMM launch", a Show HN plus Indie Hackers and Bluesky, anchor date two weeks out.
  3. A standalone weekly devlog on Mastodon and Bluesky.
- [ ] The skill reads `_voice.md` and says which voice rules it applied; asks for missing facts instead of inventing them; loads only the playbooks of the platforms in play.
- [ ] Offline: quit Obsidian, run the skill inside the vault on sample 3; reopen Obsidian: a notice and the "Written by Claude" section list the notes; nothing was reminded or posted; Approve & schedule works; a note edited to `status: scheduled` by hand is still held.
- [ ] Voice: Create voice profile creates and opens `Social/_voice.md` once; running it again opens the existing one; asking Claude to learn from published posts proposes rules and appends them only after you agree.
- [ ] Review page: ask for a review page of sample 1; it shows every post and the schedule; decisions pasted back end up under "Review decisions (date)" in the campaign note.
```

- [ ] **Step 4: Run the full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything passes. Check that `main.js` did not grow by more than about 60 KB compared with M3 (`ls -l main.js` before and after, production build): no SDK was bundled.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/getting-started.md docs/qa/m4.md
git commit -m "docs: Claude Code server, the /social skill and offline review; M4 QA checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Walk through the checklist**

Work through `docs/qa/m4.md` on a desktop with Claude Code and on two phones. For each failure, add a failing test in the owning module first, fix it and commit with `fix(...)`. The GUI and Claude Code walkthrough may be deferred to the user, as in M2b and M3.

---

## M4 Done Checklist

- [ ] All 15 tasks committed on `feat/m4-claude-code` (from `feat/m3-reminders-and-publisher-device` @ `390b154`); `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.
- [ ] `docs/qa/m4.md` checked (or deferred to the user with a ruling), including every **(QA)** item.
- [ ] Owner confirmed the hand-rolled server (ADR 0002) over the SDK named in #73.
- [ ] Issues #73–#78 and #80–#85 can be closed; epics #72 and #79 are complete. `generate_image` stays open for M6.
- [ ] Follow-ups for M5+: adapters with `update()` make `push_update` useful; the M3 P11 note (a `publishing` entry from another device with `lookup()` "not found" stays `check_needed`) applies to `publish_now` too; "Plan with Claude" / "Trim with Claude" buttons (spec §3) if wanted.
