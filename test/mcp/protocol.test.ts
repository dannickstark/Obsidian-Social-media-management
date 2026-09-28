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
