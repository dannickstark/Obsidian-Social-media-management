<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { chipStyle } from "../planner/status";
  import { longpress } from "../ui/longpress";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatTime } from "../ui/format";

  let { row, showTime = true }: { row: PostRow; showTime?: boolean } = $props();
  const { now, channels, actions } = useOsmm();
  const channel = $derived(row.channelId ? channels.get(row.channelId) : undefined);
  const style = $derived(chipStyle(row, $now, channel));
  const label = $derived(actions.rowLabel(row));
</script>

<button
  type="button"
  class="osmm-chip"
  data-style={style}
  aria-label={label}
  title={label}
  draggable={!["published", "publishing", "skipped"].includes(row.status)}
  ondragstart={(e) => actions.dragStart(e, row)}
  onclick={(e) => actions.openNote(row.variant.path, e.metaKey || e.ctrlKey)}
  onmouseenter={(e) => actions.hoverPreview(e, row.variant.path)}
  oncontextmenu={(e) => {
    e.preventDefault();
    actions.rowMenu(row, e);
  }}
  onkeydown={(e) => actions.keyMenu(e, row)}
  use:longpress={(p) => actions.rowMenu(row, p)}>
  <PlatformBadge platform={row.variant.platform} />
  {#if showTime && row.at !== undefined}<span class="osmm-chip-time">{formatTime(row.at)}</span>{/if}
  <span class="osmm-chip-title">{row.variant.displayTitle}</span>
  {#if style === "published"}<span aria-hidden="true">✓</span>{/if}
</button>
