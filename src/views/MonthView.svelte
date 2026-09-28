<script lang="ts">
  import { Menu } from "obsidian";
  import type { PostRow } from "../index/queries";
  import { anchorsByDay, groupByDay, monthGrid, weekdayLabels } from "../planner/calendar";
  import { useOsmm } from "../ui/context";
  import Chip from "./Chip.svelte";

  let { year, month, rows }: { year: number; month: number; rows: PostRow[] } = $props();
  const { settings, now, snapshot, actions } = useOsmm();
  const MAX = 4;

  const weeks = $derived(monthGrid(year, month, $settings.weekStartsOn, $now));
  const byDay = $derived(groupByDay(rows));
  const anchors = $derived(anchorsByDay($snapshot.campaigns));

  function more(event: MouseEvent, list: PostRow[]): void {
    const menu = new Menu();
    for (const r of list) menu.addItem((i) => i.setTitle(actions.rowLabel(r)).onClick(() => actions.openNote(r.variant.path)));
    menu.showAtMouseEvent(event);
  }
</script>

<div class="osmm-month" role="grid" aria-label="Month">
  <div class="osmm-month-head" role="row">
    {#each weekdayLabels($settings.weekStartsOn) as label (label)}<div role="columnheader">{label}</div>{/each}
  </div>
  {#each weeks as week, w (w)}
    <div class="osmm-month-row" role="row">
      {#each week as cell (cell.key)}
        {@const list = byDay.get(cell.key) ?? []}
        <div role="gridcell" class="osmm-day" class:is-muted={!cell.inMonth} class:is-today={cell.isToday} data-day={cell.key}>
          <div class="osmm-day-head">
            <span class="osmm-day-num">{cell.day}</span>
            {#each anchors.get(cell.key) ?? [] as c (c.path)}<span class="osmm-anchor" title={c.title}>{c.title}</span>{/each}
          </div>
          {#each list.slice(0, MAX) as row (row.key)}<Chip {row} />{/each}
          {#if list.length > MAX}
            <button type="button" class="osmm-more" onclick={(e) => more(e, list.slice(MAX))}>+{list.length - MAX} more</button>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
</div>
