<script lang="ts">
  import { heldForReview, nothingPending } from "../index/queries";
  import type { Issue } from "../model/types";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  const { snapshot, composer, actions, now } = useOsmm();
  const drafts = $derived(
    $snapshot.variants
      .filter((v) => heldForReview(v))
      .sort((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path)),
  );

  // Fix round 1 (m5): reviewIssues is re-checked only when a draft's own content actually changed, not on
  // every unrelated snapshot update — otherwise the buttons flash back to "Checking…" on every re-render.
  const fingerprint = (v: (typeof drafts)[number]): string => `${v.bodyChars}:${v.scheduledAt ?? ""}:${v.channels.join(",")}`;
  const issuesCache: Record<string, { key: string; issues: Issue[] }> = $state({});

  $effect(() => {
    for (const v of drafts) {
      const key = fingerprint(v);
      if (issuesCache[v.path]?.key === key) continue;
      void composer.reviewIssues(v).then((issues) => {
        issuesCache[v.path] = { key, issues };
      });
    }
    for (const path of Object.keys(issuesCache)) {
      if (!drafts.some((v) => v.path === path)) delete issuesCache[path];
    }
  });
</script>

{#if drafts.length}
  <section class="osmm-claude-drafts" aria-label={`Written by Claude · ${drafts.length}`}>
    <h3 class="osmm-section-title">Written by Claude · {drafts.length}</h3>
    {#each drafts as v (v.path)}
      {@const cached = issuesCache[v.path]}
      <div class="osmm-row">
        <PlatformBadge platform={v.platform} />
        <button type="button" class="osmm-row-title osmm-link" onclick={() => actions.openNote(v.path)}>{v.displayTitle}</button>
      </div>
      {#if !cached}
        <p class="osmm-progress">Checking…</p>
      {:else}
        {@const errors = cached.issues.filter((i) => i.level === "error")}
        {@const done = nothingPending(v)}
        {@const past = v.scheduledAt !== undefined && v.scheduledAt <= $now}
        <p class="osmm-progress">
          {#if errors.length}{errors[0]?.message}{:else if done}Already posted.{:else if past}The proposed time has passed{:else if v.scheduledAt !== undefined}Ready for {formatShortDate(
              v.scheduledAt,
            )} {formatTime(v.scheduledAt)}{:else}Ready. No time proposed yet.{/if}
        </p>
        <div class="osmm-row">
          <span class="osmm-spacer"></span>
          <button
            type="button"
            class="mod-cta"
            aria-label={`Approve and schedule ${v.displayTitle}`}
            disabled={errors.length > 0 || (!done && (v.scheduledAt === undefined || past))}
            onclick={() => void composer.approveClaudeDraft(v)}>Approve & schedule</button
          >
          <button type="button" aria-label={`Keep ${v.displayTitle} as a draft`} onclick={() => void composer.keepClaudeDraft(v)}>Keep as draft</button>
        </div>
      {/if}
    {/each}
  </section>
{/if}
