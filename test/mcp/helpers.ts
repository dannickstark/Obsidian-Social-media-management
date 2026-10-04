import { get } from "svelte/store";
import { ApprovalGate, type ApprovalAnswer, type ApprovalRequest } from "../../src/mcp/approval";
import { registerAllTools } from "../../src/mcp/index";
import type { McpToolDeps } from "../../src/mcp/deps";
import { ToolRegistry } from "../../src/mcp/tools";
import { Secrets } from "../../src/secrets/secrets";
import { makeCtx } from "../ui/ctx";

/** Tool results are JSON; tests read them loosely. */
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
    images: c.ctx.composer.images,
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
