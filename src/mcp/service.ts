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
      this.server = new McpHttpServer({
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
