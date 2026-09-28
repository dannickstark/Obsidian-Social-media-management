<script lang="ts">
  import { Menu } from "obsidian";
  import type { PostRow } from "../index/queries";
  import { PLATFORM_META } from "../model/platforms";
  import { sortRows, type SortKey } from "../planner/list";
  import { STATUS_LABEL } from "../planner/status";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";

  let { rows }: { rows: PostRow[] } = $props();
  const { snapshot, channels, actions } = useOsmm();
  let sortKey = $state<SortKey>("at");
  let dir = $state<"asc" | "desc">("asc");
  let selected = $state<Set<string>>(new Set());

  const titles = $derived(new Map($snapshot.campaigns.map((c) => [c.path, c.title])));
  const sorted = $derived(sortRows(rows, sortKey, dir, (p) => (p ? (titles.get(p) ?? "") : "")));
  const chosen = $derived(sorted.filter((r) => selected.has(r.key)));
  const HEADERS: Array<[SortKey, string]> = [["at", "When"], ["platform", "Platform"], ["channel", "Channel"], ["title", "Post"], ["campaign", "Campaign"], ["status", "Status"]];

  function sortBy(key: SortKey): void {
    if (sortKey === key) dir = dir === "asc" ? "desc" : "asc";
    else {
      sortKey = key;
      dir = "asc";
    }
  }
  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }
  function toggleAll(): void {
    selected = selected.size === sorted.length ? new Set() : new Set(sorted.map((r) => r.key));
  }
  function shiftMenu(event: MouseEvent): void {
    const menu = new Menu();
    const H = 3_600_000;
    for (const [label, ms] of [["+1 hour", H], ["+1 day", 24 * H], ["+1 week", 7 * 24 * H], ["−1 day", -24 * H]] as const) {
      menu.addItem((i) => i.setTitle(label).onClick(() => void actions.bulkShift(chosen, ms)));
    }
    menu.showAtMouseEvent(event);
  }
  function statusMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const s of ["idea", "draft", "ready"] as const) menu.addItem((i) => i.setTitle(STATUS_LABEL[s]).onClick(() => void actions.bulkSetStatus(chosen, s)));
    menu.showAtMouseEvent(event);
  }
</script>

{#if chosen.length}
  <div class="osmm-bulkbar" role="toolbar" aria-label="Bulk actions">
    <span>{chosen.length} selected</span>
    <button type="button" onclick={shiftMenu}>Shift</button>
    <button type="button" onclick={statusMenu}>Set status</button>
    <button type="button" class="mod-warning" onclick={() => void actions.bulkTrash(chosen).then(() => (selected = new Set()))}>Move to trash</button>
  </div>
{/if}
<table class="osmm-table">
  <thead>
    <tr>
      <th><input type="checkbox" aria-label="Select all" checked={selected.size > 0 && selected.size === sorted.length} onchange={toggleAll} /></th>
      {#each HEADERS as [key, label] (key)}
        <th aria-sort={sortKey === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" onclick={() => sortBy(key)}>{label}</button>
        </th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each sorted as r (r.key)}
      <tr>
        <td><input type="checkbox" aria-label={`Select ${r.variant.displayTitle}`} checked={selected.has(r.key)} onchange={() => toggle(r.key)} /></td>
        <td>{r.at !== undefined ? `${formatShortDate(r.at)} ${formatTime(r.at)}` : "—"}</td>
        <td><span class="osmm-row"><PlatformBadge platform={r.variant.platform} />{PLATFORM_META[r.variant.platform].label}</span></td>
        <td>{r.channelId ? (channels.get(r.channelId)?.name ?? r.channelId) : "—"}</td>
        <td><button type="button" class="osmm-link" onclick={() => actions.openNote(r.variant.path)}>{r.variant.displayTitle}</button></td>
        <td>{r.variant.campaignPath ? (titles.get(r.variant.campaignPath) ?? "") : "Standalone"}</td>
        <td><span class="osmm-pill-status">{STATUS_LABEL[r.status]}</span></td>
      </tr>
    {/each}
  </tbody>
</table>
