import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isSupportedVersion, RPC_ERRORS, rpcError } from "./protocol";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT = 8;
// Node's `requestTimeout`: time allowed to receive the request. It is not a response deadline, so
// it never cuts short the (up to two minute) in-Obsidian approval wait a tool call may be behind (P8).
export const REQUEST_TIMEOUT_MS = 30_000;

type CreateServer = typeof import("node:http").createServer;

export interface RequestInfo {
  at: number;
  status: number;
  path: string;
  method: string;
}

export interface McpServerDeps {
  /** Node's http.createServer; injected so this module never loads Node code on phones. */
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

/** Constant-time comparison of `Bearer <token>` with the expected token. Never logs either value. */
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

/** Reads the body up to `limit` bytes; null when it is larger (the rest of the connection is dropped). */
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
 * MCP Streamable HTTP (JSON responses only, no SSE, no sessions) on 127.0.0.1 (spec §6.1).
 * Every security check runs before the body is read: loopback peer, Host, no Origin, path,
 * token, method, content type, protocol version, size, concurrency (ADR 0002).
 *
 * Deliberate, non-obvious points, spelled out so a future change does not "fix" them into a
 * regression (P8): JSON-RPC batches are always refused with 400, even though 2025-03-26 allows
 * them; any `Origin` header is refused, including a loopback one, which is stricter than the MCP
 * spec's "validate Origin" rule; `REQUEST_TIMEOUT_MS` bounds only how long Node waits to *receive*
 * the request, never the response, so it does not cut short a multi-minute in-Obsidian approval
 * wait behind a tool call.
 */
export class McpHttpServer {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private active = 0;
  /** Flipped at the start of stop(); a request still being read when it flips gets no dispatch, no log. */
  private stopped = true;

  constructor(private readonly deps: McpServerDeps) {}

  get port(): number | null {
    return this.boundPort;
  }

  async start(port: number): Promise<number> {
    await this.stop();
    this.stopped = false;
    // Periodically drops stale/half-open connections so a reload always finds a clean socket set.
    const server = this.deps.createServer({ connectionsCheckingInterval: 5_000 }, (req, res) => void this.route(req, res));
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
    this.stopped = true;
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
    // A request that outlived stop() is reported nowhere: the server that would show it in its
    // settings/status UI is gone.
    if (this.stopped) return;
    try {
      this.deps.onRequest?.({ at: this.deps.now(), status, path: pathOf(req.url), method: req.method ?? "" });
    } catch {
      // Caller-supplied telemetry must never crash a request that has already been answered.
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch {
      // A connection the client (or stop()) already tore down has nothing left to answer. Note:
      // `req.destroyed` is not a useful signal here — Node marks a fully-read IncomingMessage
      // destroyed once its body stream ends, which is true for every ordinary request by the time
      // a later error (e.g. a handler crash) is caught, not just an aborted one.
      if (res.destroyed || res.socket?.destroyed) return;
      // Never expose a stack trace or any request detail to the caller.
      if (!res.headersSent) this.finish(req, res, 500, rpcError(null, RPC_ERRORS.internal, "Internal error."));
      else res.destroy();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.boundPort ?? 0;
    // Every check below runs before any byte of the body is read.
    if (!isLoopback(req.socket.remoteAddress)) return this.finish(req, res, 403, { error: "Only connections from this computer are accepted." });
    if (!hostAllowed(req.headers.host, port)) return this.finish(req, res, 403, { error: "Invalid Host header." });
    // Any Origin header is refused, including a loopback one: a real MCP client never sets it; only
    // a browser page does (fetch/XHR/form POST), so this is the CSRF/DNS-rebinding line (P8).
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
    if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return this.finish(req, res, 415, { error: "Use Content-Type: application/json." });
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
      // Batches are always refused, even though 2025-03-26 allows them (P8): the dispatcher and
      // every tool are written for exactly one message per request.
      if (Array.isArray(message)) return this.finish(req, res, 400, rpcError(null, RPC_ERRORS.invalidRequest, "Batches are not supported."));
      // The body may finish arriving just as (or after) stop() runs; don't dispatch or log it — the
      // server that would send the response, or record it, is already gone.
      if (this.stopped) return;
      const response = await this.deps.handle(message);
      if (response === null) return this.finish(req, res, 202);
      return this.finish(req, res, 200, response);
    } finally {
      this.active--;
    }
  }
}
