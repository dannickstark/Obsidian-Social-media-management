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
