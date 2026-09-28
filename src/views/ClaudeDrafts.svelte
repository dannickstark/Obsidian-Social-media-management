<script lang="ts">
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  const { snapshot, composer, actions } = useOsmm();
  const drafts = $derived(
    $snapshot.variants
      .filter((v) => v.review === "claude")
      .sort((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path)),
  );
</script>

{#if drafts.length}
  <section class="osmm-claude-drafts" aria-label={`Written by Claude · ${drafts.length}`}>
    <h3 class="osmm-section-title">Written by Claude · {drafts.length}</h3>
    {#each drafts as v (v.path)}
      <div class="osmm-row">
        <PlatformBadge platform={v.platform} />
        <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(v.path)}>{v.displayTitle}</button>
      </div>
      {#await composer.reviewIssues(v)}
        <p class="osmm-progress">Checking…</p>
      {:then issues}
        {@const errors = issues.filter((i) => i.level === "error")}
        <p class="osmm-progress">
          {#if errors.length}{errors[0]?.message}{:else if v.scheduledAt !== undefined}Ready for {formatShortDate(v.scheduledAt)} {formatTime(v.scheduledAt)}{:else}Ready. No time proposed yet.{/if}
        </p>
        <div class="osmm-row">
          <span class="osmm-spacer"></span>
          <button
            type="button"
            class="mod-cta"
            aria-label={`Approve and schedule ${v.displayTitle}`}
            disabled={errors.length > 0 || v.scheduledAt === undefined}
            onclick={() => void composer.approveClaudeDraft(v)}>Approve & schedule</button
          >
          <button type="button" aria-label={`Keep ${v.displayTitle} as a draft`} onclick={() => void composer.keepClaudeDraft(v)}>Keep as draft</button>
        </div>
      {/await}
    {/each}
  </section>
{/if}
