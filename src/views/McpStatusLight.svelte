<script lang="ts">
  import { readable } from "svelte/store";
  import type { McpStatus } from "../mcp/service";
  import { useOsmm } from "../ui/context";

  const { mcp } = useOsmm();
  const status = mcp?.status ?? readable<McpStatus>({ state: "unavailable" });

  function label(s: McpStatus): string {
    switch (s.state) {
      case "on":
        return `Claude Code: ready on port ${s.port}`;
      case "starting":
        return "Claude Code: starting";
      case "error":
        return "Claude Code: not running";
      default:
        return "Claude Code: off";
    }
  }
</script>

{#if $status.state !== "unavailable"}
  <div class="osmm-mcp-status" data-state={$status.state} title={$status.state === "error" ? $status.message : undefined}>
    <span class="osmm-mcp-dot" aria-hidden="true"></span>
    <span>{label($status)}</span>
  </div>
{/if}
