<script lang="ts">
  import { campaignProgress, expandRows, overdueRows, upcomingRows } from "../index/queries";
  import { startOfLocalDay, addLocalDays } from "../model/dates";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";
  import ClaudeDrafts from "./ClaudeDrafts.svelte";
  import McpStatusLight from "./McpStatusLight.svelte";
  import PublisherBanner from "./PublisherBanner.svelte";

  const { snapshot, settings, now, channels, actions, composer, publish } = useOsmm();
  const rows = $derived(expandRows($snapshot.variants, $settings.defaultStaggerMinutes));
  const overdue = $derived(overdueRows(rows, $now));
  const attention = $derived(rows.filter((r) => r.channelId !== null && (r.status === "failed" || r.status === "check_needed")));
  const endOfDay = $derived(addLocalDays(startOfLocalDay($now), 1));
  const upNext = $derived(upcomingRows(rows, $now, endOfDay - $now));
  const campaigns = $derived(
    $snapshot.campaigns
      .filter((c) => c.status === "active")
      .map((c) => ({ c, ...campaignProgress($snapshot.variants, c.path) }))
      .sort((a, b) => (a.c.anchorDate ?? Infinity) - (b.c.anchorDate ?? Infinity)),
  );
  const channelName = (id: string | null) => (id ? (channels.get(id)?.name ?? id) : "");
</script>

<div class="osmm-sidebar">
  <PublisherBanner />
  <McpStatusLight />
  <button type="button" class="mod-cta" onclick={() => actions.quickCreate("campaign")}>New campaign</button>
  {#if overdue.length}
    <section class="osmm-overdue" aria-label={`Overdue · ${overdue.length}`}>
      <h3 class="osmm-section-title">Overdue · {overdue.length}</h3>
      {#each overdue as r (r.key)}
        <div class="osmm-row">
          <PlatformBadge platform={r.variant.platform} />
          <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button>
        </div>
        <div class="osmm-row">
          <span class="osmm-progress">{r.at !== undefined ? `${formatShortDate(r.at)} ${formatTime(r.at)}` : ""}{r.channelId ? ` · ${channelName(r.channelId)}` : ""}</span>
          <span class="osmm-spacer"></span>
          <button type="button" class="mod-cta" aria-label={`Post ${r.variant.displayTitle} now`} onclick={() => void publish.postNow(r.variant.path, r.channelId ? [r.channelId] : undefined)}>Post now</button>
          <button type="button" onclick={(e) => actions.quickReschedule(e, r)}>Reschedule</button>
          <button type="button" aria-label={`Skip ${r.variant.displayTitle}`} onclick={() => void actions.skip(r)}>Skip</button>
        </div>
      {/each}
    </section>
  {/if}

  {#if attention.length}
    <section class="osmm-attention" aria-label={`Needs attention · ${attention.length}`}>
      <h3 class="osmm-section-title">Needs attention · {attention.length}</h3>
      {#each attention as r (r.key)}
        {@const error = r.channelId ? r.variant.deliveries[r.channelId]?.error : undefined}
        <div class="osmm-row">
          <PlatformBadge platform={r.variant.platform} />
          <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button>
        </div>
        <p class="osmm-progress">{channelName(r.channelId)}{error ? ` · ${error}` : ""}</p>
        <div class="osmm-row">
          <span class="osmm-spacer"></span>
          {#if r.status === "failed"}
            <button type="button" aria-label={`Post ${r.variant.displayTitle} on ${channelName(r.channelId)} again`} onclick={() => void publish.postNow(r.variant.path, [r.channelId!])}>Post again</button>
            <button type="button" aria-label={`Fix ${r.variant.displayTitle} on ${channelName(r.channelId)}`} onclick={() => void composer.openComposer(r.variant.path)}>Fix</button>
          {:else}
            <button type="button" aria-label={`${r.variant.displayTitle} on ${channelName(r.channelId)} went out`} onclick={() => publish.openAssisted(r.variant.path, [r.channelId!], 3)}>It went out</button>
            <button type="button" aria-label={`${r.variant.displayTitle} on ${channelName(r.channelId)} didn't go out`} onclick={() => void publish.resolveNotPublished(r.variant.path, r.channelId!)}>It didn't</button>
            {#if publish.canLookup(r.variant.path)}
              <button type="button" aria-label={`Check ${r.variant.displayTitle} on ${channelName(r.channelId)} again`} onclick={() => void publish.resolveCheck(r.variant.path, r.channelId!)}>Check again</button>
            {/if}
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  <ClaudeDrafts />

  <section aria-label="Up next · today">
    <h3 class="osmm-section-title">Up next · today</h3>
    {#each upNext as r (r.key)}
      <button type="button" class="osmm-row osmm-card" onclick={() => actions.openNote(r.variant.path)}>
        <span class="osmm-progress">{r.at !== undefined ? formatTime(r.at) : ""}</span>
        <PlatformBadge platform={r.variant.platform} />
        <span class="osmm-row-title">{r.variant.displayTitle}</span>
      </button>
    {:else}
      <p class="osmm-progress">Nothing else today.</p>
    {/each}
  </section>

  <section aria-label="Campaigns">
    <h3 class="osmm-section-title">Campaigns</h3>
    {#each campaigns as { c, published, total } (c.path)}
      <button type="button" class="osmm-row osmm-link" onclick={() => actions.openNote(c.path)}>
        <span class="osmm-row-title">{c.title}</span>
        <span class="osmm-progress">{published}/{total}</span>
      </button>
    {/each}
  </section>
</div>
