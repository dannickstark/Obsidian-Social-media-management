<script lang="ts">
  import { PLATFORM_META } from "../model/platforms";
  import type { TemplateProposal } from "../planner/templates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { proposals, close }: { proposals: TemplateProposal[]; close: () => void } = $props();
  const { actions } = useOsmm();
  const when = (ms?: number) => (ms === undefined ? "—" : `${formatShortDate(ms)} ${formatTime(ms)}`);
</script>

{#if proposals.length}
  <table class="osmm-table">
    <thead><tr><th>Step</th><th>Post</th><th>From</th><th>To</th></tr></thead>
    <tbody>
      {#each proposals as p (p.variant.path)}
        <tr>
          <td>{p.label}</td>
          <td><span class="osmm-row"><PlatformBadge platform={p.variant.platform} />{PLATFORM_META[p.variant.platform].label} · {p.variant.displayTitle}</span></td>
          <td>{when(p.from)}</td>
          <td><strong>{when(p.to)}</strong></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="modal-button-container">
    <button type="button" class="mod-cta" onclick={() => void actions.applyTemplate(proposals).then(close)}>Apply to {proposals.length} posts</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
{:else}
  <p>No unpublished variants match this template's platforms.</p>
{/if}
