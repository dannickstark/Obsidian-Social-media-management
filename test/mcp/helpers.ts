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
