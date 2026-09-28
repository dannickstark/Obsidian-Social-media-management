// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { hostAllowed, isLoopback, MAX_BODY_BYTES, MAX_CONCURRENT, McpHttpServer, tokenMatches, type RequestInfo } from "../../src/mcp/server";

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
    let arrived = 0;
    const { port } = await build({
      handle: async () => {
        arrived++;
        await gate;
        return { jsonrpc: "2.0", id: 1, result: {} };
      },
    });
    const pending = Array.from({ length: MAX_CONCURRENT }, () => send(port, { headers: auth, body: ping }));
    // Wait for all 8 to actually be inside the handler, not a fixed sleep, so this can't flake under load.
    while (arrived < MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 1));
    expect((await send(port, { headers: auth, body: ping })).status).toBe(503);
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(MAX_CONCURRENT).fill(200));
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

  it("configures periodic stale-connection checking on the underlying http.Server", async () => {
    const calls: unknown[] = [];
    const wrapped = ((...args: Parameters<typeof http.createServer>) => {
      calls.push(args[0]);
      return http.createServer(...(args as Parameters<typeof http.createServer>));
    }) as typeof http.createServer;
    const server = new McpHttpServer({ createServer: wrapped, token: () => TOKEN, handle: async () => null, version: "0", now: () => 0 });
    const port = await server.start(0);
    servers.push(server);
    expect(calls).toEqual([{ connectionsCheckingInterval: 5_000 }]);
    expect((await send(port, { headers: auth, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status).toBe(202);
  });

  it("releases its concurrency slot when a mid-body request is aborted", async () => {
    const { port } = await build();
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: { Host: `127.0.0.1:${port}`, ...auth, "Transfer-Encoding": "chunked" },
      });
      req.on("error", () => undefined);
      req.write("partial-body-never-finished");
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 20);
      }, 20);
    });
    const results = await Promise.all(Array.from({ length: MAX_CONCURRENT }, () => send(port, { headers: auth, body: ping })));
    expect(results.map((r) => r.status)).toEqual(Array(MAX_CONCURRENT).fill(200));
  });

  it("gives no handle call and no onRequest entry to a request still in flight when stop() is called", async () => {
    let handleCalls = 0;
    const { server, port, requests } = await build({
      handle: async () => {
        handleCalls++;
        return { jsonrpc: "2.0", id: 1, result: {} };
      },
    });
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: { Host: `127.0.0.1:${port}`, ...auth, "Transfer-Encoding": "chunked" },
      });
      req.on("error", () => undefined);
      req.write("partial-body-never-finished");
      setTimeout(resolve, 20);
    });
    await server.stop();
    expect(handleCalls).toBe(0);
    expect(requests).toEqual([]);
  });

  it("refuses Origin: null and an empty Origin, same as any other Origin", async () => {
    const { port } = await build();
    expect((await send(port, { headers: { ...auth, Origin: "null" }, body: ping })).status).toBe(403);
    expect((await send(port, { headers: { ...auth, Origin: "" }, body: ping })).status).toBe(403);
  });

  it("refuses a token of a different length at the HTTP level", async () => {
    const { port } = await build();
    expect((await send(port, { headers: { ...auth, Authorization: `Bearer ${"X".repeat(10)}` }, body: ping })).status).toBe(401);
    expect((await send(port, { headers: { ...auth, Authorization: `Bearer ${"X".repeat(200)}` }, body: ping })).status).toBe(401);
  });

  it("tightens the Content-Type check to application/json optionally followed by parameters", async () => {
    const { port } = await build();
    expect((await send(port, { headers: { ...auth, "Content-Type": "APPLICATION/JSON" }, body: ping })).status).toBe(200);
    expect((await send(port, { headers: { ...auth, "Content-Type": "application/json; charset=utf-8" }, body: ping })).status).toBe(200);
    // A real bug in the old `\b`-based regex: "-" is a non-word character, so `application/json\b` matched
    // this even though it names a different media type entirely.
    expect((await send(port, { headers: { ...auth, "Content-Type": "application/json-patch+json" }, body: ping })).status).toBe(415);
    expect((await send(port, { headers: { ...auth, "Content-Type": "application/jsonxyz" }, body: ping })).status).toBe(415);
  });

  it("closes an idle keep-alive socket on stop()", async () => {
    const { server, port } = await build();
    const agent = new http.Agent({ keepAlive: true });
    let socket: import("node:net").Socket | undefined;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { Host: `127.0.0.1:${port}`, ...auth }, agent },
        (res) => {
          res.on("data", () => undefined);
          res.on("end", () => resolve());
        },
      );
      req.on("socket", (s) => (socket = s));
      req.on("error", reject);
      req.end(ping);
    });
    // Let the socket settle into the agent's free pool before we stop the server.
    await new Promise((r) => setTimeout(r, 20));
    expect(socket?.destroyed).toBe(false);
    // The client-side socket learns of the close over the (loopback) network, which is never
    // synchronous with the server's own stop(): wait for the real "close" event, not a poll.
    const closed = new Promise<void>((resolve) => socket?.once("close", resolve));
    await server.stop();
    await closed;
    expect(socket?.destroyed).toBe(true);
    agent.destroy();
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
