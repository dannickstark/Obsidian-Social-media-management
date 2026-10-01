<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORM_META } from "../model/platforms";
  import { handedOverChannels, type SyncInfo } from "../publish/sync";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { variant }: { variant: IndexedVariant } = $props();
  const { channels, publish } = useOsmm();
  const rows = $derived(handedOverChannels(variant));
  const label = $derived(PLATFORM_META[variant.platform].label);
  const when = (at: number | undefined): string => (at === undefined ? "its time" : `${formatShortDate(at)} ${formatTime(at)}`);
  const name = (id: string): string => channels.get(id)?.name ?? id;

  function describe(s: SyncInfo): string {
    if (s.state === "unknown") return `Handed over to ${label}.`;
    if (s.state === "in_sync") return `Scheduled on ${label} for ${when(s.remoteAt)}.`;
    const what = [s.content ? "the text or media changed" : "", s.time ? `the time here is ${when(s.at)}` : ""].filter(Boolean).join(", and ");
    return `${label} has the version for ${when(s.remoteAt)}; ${what}.`;
  }
</script>

{#if rows.length}
  <section class="osmm-panel" aria-label={`Scheduled on ${label}`}>
    <h4>Scheduled on {label}</h4>
    <ul class="osmm-sync-list">
      {#each rows as s (s.channelId)}
        <li>
          <div class="osmm-row">
            <span class="osmm-row-title">{name(s.channelId)}</span>
            {#if s.state === "out_of_sync"}<span class="osmm-pill-sync">Out of sync</span>{/if}
          </div>
          <p class="osmm-progress">{describe(s)}</p>
          <div class="osmm-chips">
            {#if s.state !== "in_sync"}<button type="button" class="mod-cta" aria-label={`Push update for ${name(s.channelId)}`} onclick={() => void publish.pushUpdate(variant.path, s.channelId)}>Push update</button>{/if}
            {#if s.time}<button type="button" aria-label={`Revert time for ${name(s.channelId)}`} onclick={() => void publish.revertTime(variant.path, s.channelId)}>Revert time</button>{/if}
            <button type="button" aria-label={`Unschedule ${name(s.channelId)} on ${label}`} onclick={() => void publish.unscheduleRemote(variant.path, s.channelId)}>Unschedule on {label}</button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
