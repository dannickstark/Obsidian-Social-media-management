<script lang="ts">
  import type { PlannerMode } from "../planner/viewState";

  let { modes, value, onchange }: { modes: readonly PlannerMode[]; value: PlannerMode; onchange: (mode: PlannerMode) => void } = $props();
  const LABEL: Record<PlannerMode, string> = { month: "Month", week: "Week", board: "Board", list: "List" };
</script>

<div class="osmm-segmented" role="group" aria-label="View">
  {#each modes as mode (mode)}
    <button type="button" class:is-active={mode === value} aria-pressed={mode === value} onclick={() => onchange(mode)}>{LABEL[mode]}</button>
  {/each}
</div>
