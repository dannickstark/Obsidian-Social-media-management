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
