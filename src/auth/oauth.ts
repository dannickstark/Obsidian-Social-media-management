import type { ClientRequest, IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { createPkce, equalState, newState } from "./pkce";

export interface OAuthProviderConfig {
  provider: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPort?: number;
  redirectPath?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface TokenRequest {
  url: string;
  method: "POST";
  body: string;
  headers: { "Content-Type": "application/x-www-form-urlencoded" };
  signal?: AbortSignal;
}

export interface TokenResponse {
  status: number;
  text: string;
}

export interface LoopbackListener {
  redirectUri: string;
  result: Promise<string>;
  close(): Promise<void>;
}

export interface OAuthDependencies {
  openBrowser(url: string): void | Promise<void>;
  requestToken(request: TokenRequest): Promise<TokenResponse>;
  listen(port: number, state: string, path: string): Promise<LoopbackListener>;
  timeoutMs: number;
  now(): number;
}

function validRedirectPath(path: string): string {
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) throw new Error("Invalid OAuth redirect path.");
  return path;
}

function validConfig(config: OAuthProviderConfig): void {
  if (!config.provider || !config.clientId || !Array.isArray(config.scopes) || config.scopes.some((scope) => !scope || typeof scope !== "string")) {
    throw new Error("Invalid OAuth provider configuration.");
  }
  for (const raw of [config.authorizeUrl, config.tokenUrl]) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("Invalid OAuth provider URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("OAuth provider URLs must use HTTPS.");
  }
  if (config.redirectPort !== undefined && (!Number.isInteger(config.redirectPort) || config.redirectPort < 0 || config.redirectPort > 65535)) {
    throw new Error("Invalid OAuth redirect port.");
  }
  validRedirectPath(config.redirectPath ?? "/callback");
}

function parseTokens(response: TokenResponse, now: number): OAuthTokens {
  if (response.status < 200 || response.status >= 300) throw new Error("OAuth token exchange failed.");
  let data: unknown;
  try { data = JSON.parse(response.text); } catch { throw new Error("Malformed OAuth token response."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Malformed OAuth token response.");
  const value = data as Record<string, unknown>;
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Malformed OAuth token response.");
  const tokens: OAuthTokens = { accessToken: value.access_token };
  if (value.refresh_token !== undefined) {
    if (typeof value.refresh_token !== "string" || !value.refresh_token) throw new Error("Malformed OAuth token response.");
    tokens.refreshToken = value.refresh_token;
  }
  if (value.scope !== undefined) {
    if (typeof value.scope !== "string") throw new Error("Malformed OAuth token response.");
    tokens.scope = value.scope;
  }
  if (value.expires_in !== undefined) {
    const seconds = typeof value.expires_in === "string" && value.expires_in.trim() ? Number(value.expires_in) : value.expires_in;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(now + seconds * 1000)) {
      throw new Error("Malformed OAuth token response.");
    }
    tokens.expiresAt = now + seconds * 1000;
  }
  return tokens;
}

/** A single local callback. Neither the state nor code is included in responses or error messages. */
export async function listenLoopback(port: number, state: string, path = "/callback"): Promise<LoopbackListener> {
  validRedirectPath(path);
  // The Node listener is unavailable on phones; defer loading until a desktop flow actually starts.
  const { createServer } = await import("node:http");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  result.catch(() => undefined);
  let consumed = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (consumed) { res.writeHead(410).end("Callback already handled."); return; }
    const address = server.address();
    if (!address || typeof address === "string") { res.writeHead(503).end(); return; }
    const host = `127.0.0.1:${address.port}`;
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== host) {
      consumed = true;
      res.writeHead(403).end("Loopback callback required.");
      rejectCode(new Error("Non-loopback OAuth callback rejected."));
      return;
    }
    if (req.method !== "GET" || !req.url?.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(404).end("Callback path required.");
      return;
    }
    let url: URL;
    try { url = new URL(req.url, `http://${host}`); } catch { res.writeHead(400).end("Invalid callback."); return; }
    if (url.pathname !== path) { res.writeHead(404).end("Callback path required."); return; }
    consumed = true;
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !equalState(state, states[0] ?? "")) {
      res.writeHead(401).end("Invalid callback state.");
      rejectCode(new Error("OAuth callback state mismatch."));
      return;
    }
    const errors = url.searchParams.getAll("error");
    if (errors.length) {
      res.writeHead(400).end("Authorization declined.");
      rejectCode(new Error("OAuth provider denied authorization."));
      return;
    }
    const codes = url.searchParams.getAll("code");
    if (codes.length !== 1 || !codes[0]) {
      res.writeHead(400).end("Authorization code required.");
      rejectCode(new Error("OAuth callback did not include one authorization code."));
      return;
    }
    res.writeHead(200).end("Authorization received. You may close this tab.");
    resolveCode(codes[0]);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch {
    server.close();
    throw new Error("Could not open OAuth loopback listener.");
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open OAuth loopback listener.");
  return {
    redirectUri: `http://127.0.0.1:${address.port}${path}`, result,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
    },
  };
}

type RequestOptions = { method: "POST"; headers: Record<string, string>; signal?: AbortSignal };
type RequestOpener = (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

/** Node's HTTPS request performs one request and never follows Location. The opener is injected for transport tests. */
export async function postTokenNoFollow(req: TokenRequest, opener?: RequestOpener): Promise<TokenResponse> {
  const url = new URL(req.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("OAuth token endpoint must use HTTPS.");
  const open = opener ?? (await import("node:https")).request;
  return new Promise<TokenResponse>((resolve, reject) => {
    const headers = { ...req.headers, Accept: "application/json", "Content-Length": String(Buffer.byteLength(req.body)) };
    const request = open(url, { method: "POST", headers, signal: req.signal }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error("OAuth token endpoint redirected; credentials were not forwarded."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          response.destroy();
          reject(new Error("OAuth token response is too large."));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => reject(new Error("OAuth token request failed.")));
    });
    request.on("error", () => reject(new Error("OAuth token request failed.")));
    request.end(req.body);
  });
}

const defaults: OAuthDependencies = {
  openBrowser: (url) => { window.open(url); },
  requestToken: postTokenNoFollow,
  listen: listenLoopback,
  timeoutMs: 120_000,
  now: () => Date.now(),
};

/** Provider-neutral public-client OAuth flow. Provider-specific eligibility must be validated before calling it. */
export class OAuthFlow {
  private active: AbortController | null = null;
  private readonly deps: OAuthDependencies;

  constructor(deps: Partial<OAuthDependencies> = {}) { this.deps = { ...defaults, ...deps }; }

  cancel(): void { this.active?.abort(); }

  async start(config: OAuthProviderConfig, signal?: AbortSignal): Promise<OAuthTokens> {
    validConfig(config);
    const path = config.redirectPath ?? "/callback";
    if (this.active) throw new Error("An OAuth flow is already active.");
    if (signal?.aborted) throw new Error("OAuth flow cancelled.");
    if (!Number.isSafeInteger(this.deps.timeoutMs) || this.deps.timeoutMs < 1) throw new Error("Invalid OAuth timeout.");
    const controller = new AbortController();
    this.active = controller;
    let listener: LoopbackListener | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let ended = false;
    const stopped = new Promise<never>((_, reject) => {
      const cancel = () => reject(new Error("OAuth flow cancelled."));
      controller.signal.addEventListener("abort", cancel, { once: true });
      onAbort = () => controller.signal.removeEventListener("abort", cancel);
      timer = setTimeout(() => { reject(new Error("OAuth flow timed out.")); controller.abort(); }, this.deps.timeoutMs);
    });
    stopped.catch(() => undefined);
    if (signal) {
      const externalAbort = () => controller.abort();
      signal.addEventListener("abort", externalAbort, { once: true });
      const prior = onAbort;
      onAbort = () => { prior?.(); signal.removeEventListener("abort", externalAbort); };
      if (signal.aborted) controller.abort();
    }
    try {
      const { verifier, challenge } = await Promise.race([createPkce(), stopped]);
      const state = newState();
      const opening = this.deps.listen(config.redirectPort ?? 0, state, path);
      opening.then((opened) => { if (ended) void opened.close().catch(() => undefined); }).catch(() => undefined);
      listener = await Promise.race([opening, stopped]);
      const redirect = new URL(listener.redirectUri);
      if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== path || !redirect.port || redirect.search || redirect.hash || redirect.username || redirect.password || (config.redirectPort && Number(redirect.port) !== config.redirectPort)) {
        throw new Error("OAuth listener returned a non-loopback callback.");
      }
      const auth = new URL(config.authorizeUrl);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("redirect_uri", listener.redirectUri);
      auth.searchParams.set("scope", config.scopes.join(" "));
      auth.searchParams.set("state", state);
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("code_challenge_method", "S256");
      try {
        await Promise.race([Promise.resolve().then(() => this.deps.openBrowser(auth.href)), stopped]);
      } catch (error) {
        if (error instanceof Error && /^OAuth flow (cancelled|timed out)\.$/.test(error.message)) throw error;
        throw new Error("Could not open OAuth authorization page.");
      }
      const code = await Promise.race([listener.result, stopped]);
      const body = new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: listener.redirectUri, code_verifier: verifier });
      let response: TokenResponse;
      try {
        response = await Promise.race([this.deps.requestToken({ url: config.tokenUrl, method: "POST", body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: controller.signal }), stopped]);
      } catch (error) {
        if (error instanceof Error && /^OAuth flow (cancelled|timed out)\.$/.test(error.message)) throw error;
        throw new Error("OAuth token exchange failed.");
      }
      return parseTokens(response, this.deps.now());
    } finally {
      ended = true;
      if (timer) clearTimeout(timer);
      onAbort?.();
      try { await listener?.close(); } finally { this.active = null; }
    }
  }
}
