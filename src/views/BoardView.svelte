<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { BOARD_COLUMNS, columnOf, type BoardColumn } from "../planner/board";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { variants }: { variants: IndexedVariant[] } = $props();
  const { snapshot, now, actions } = useOsmm();
  const TITLES: Record<BoardColumn, string> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", published: "Published" };
  const MIME = "text/x-osmm-variant";
  let dropColumn = $state<BoardColumn | null>(null);

  const campaignTitle = $derived(new Map($snapshot.campaigns.map((c) => [c.path, c.title])));
  const columns = $derived(
    BOARD_COLUMNS.map((col) => ({
      col,
      cards: variants.filter((v) => columnOf(v.status) === col).sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity)),
    })),
  );

  function drop(event: DragEvent, col: BoardColumn): void {
    event.preventDefault();
    dropColumn = null;
    const path = event.dataTransfer?.getData(MIME);
    const v = variants.find((x) => x.path === path);
    if (v) void actions.moveOnBoard(v, col);
  }
</script>

<div class="osmm-board">
  {#each columns as { col, cards } (col)}
    <section
      class="osmm-column"
      class:is-drop={dropColumn === col}
      aria-label={TITLES[col]}
      ondragover={(e) => {
        e.preventDefault();
        dropColumn = col;
      }}
      ondragleave={() => (dropColumn = null)}
      ondrop={(e) => drop(e, col)}>
      <h3 class="osmm-column-head">{TITLES[col]} <span class="osmm-progress">{cards.length}</span></h3>
      {#each cards as v (v.path)}
        {@const late = v.status === "overdue" || (v.status === "scheduled" && v.scheduledAt !== undefined && v.scheduledAt < $now)}
        <button
          type="button"
          class="osmm-card"
          class:is-late={late}
          draggable="true"
          ondragstart={(e) => e.dataTransfer?.setData(MIME, v.path)}
          onclick={() => actions.openNote(v.path)}>
          <span class="osmm-row"><PlatformBadge platform={v.platform} size="md" /><strong class="osmm-row-title">{v.displayTitle}</strong></span>
          {#if v.excerpt && v.excerpt !== v.displayTitle}<span>{v.excerpt}</span>{/if}
          <span class="osmm-card-meta">
            <span>{v.campaignPath ? (campaignTitle.get(v.campaignPath) ?? "") : "Standalone"}</span>
            <span class="osmm-spacer"></span>
            <span>{v.scheduledAt !== undefined ? `${formatShortDate(v.scheduledAt)} ${formatTime(v.scheduledAt)}` : "—"}</span>
          </span>
        </button>
      {/each}
    </section>
  {/each}
</div>
