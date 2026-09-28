<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { campaignTimeline } from "../planner/templates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { formatShortDate } from "../ui/format";

  let { anchor, variants }: { anchor: number; variants: IndexedVariant[] } = $props();
  const steps = $derived(campaignTimeline(anchor, variants));
</script>

<ol class="osmm-timeline" aria-label="Campaign timeline">
  {#each steps as s (s.label)}
    <li class="osmm-row">
      <span class="osmm-progress">{s.label}</span>
      <span>{formatShortDate(s.date)}</span>
      <span class="osmm-row">{#each s.platforms as p (p)}<PlatformBadge platform={p} />{/each}</span>
      {#if s.done}<span aria-label="done">✓</span>{/if}
    </li>
  {/each}
</ol>
