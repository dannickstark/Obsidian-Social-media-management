import type { McpToolDeps } from "./deps";
import { registerPublishTools } from "./tools/publish";
import { registerReadTools } from "./tools/read";
import { registerScheduleTools } from "./tools/schedule";
import { registerSlotTools } from "./tools/slots";
import { registerVoiceTools } from "./tools/voice";
import { registerWriteTools } from "./tools/write";
import type { ToolRegistry } from "./tools";

/** Every MCP tool (spec §6.1). Later tasks add their groups here. */
export function registerAllTools(registry: ToolRegistry, deps: McpToolDeps): void {
  registerReadTools(registry, deps);
  registerWriteTools(registry, deps);
  registerScheduleTools(registry, deps);
  registerSlotTools(registry, deps);
  registerPublishTools(registry, deps);
  registerVoiceTools(registry, deps);
}
