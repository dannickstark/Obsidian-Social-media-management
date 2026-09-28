<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { PX_PER_MINUTE, groupByDay, layoutDay, minutesOfDay, weekCells } from "../planner/calendar";
  import { useOsmm } from "../ui/context";
  import Chip from "./Chip.svelte";

  let { anchor, rows }: { anchor: number; rows: PostRow[] } = $props();
  const { settings, now, actions } = useOsmm();
  const HOURS = Array.from({ length: 24 }, (_, h) => h);

  const cells = $derived(weekCells(anchor, $settings.weekStartsOn, $now));
  const byDay = $derived(groupByDay(rows));
  let scroller: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (scroller) scroller.scrollTop = 7 * 60 * PX_PER_MINUTE;
  });
</script>

<div class="osmm-week-scroll" bind:this={scroller} style:height="100%" style:overflow="auto">
  <div class="osmm-week" role="grid" aria-label="Week">
    <div class="osmm-week-head" role="columnheader"></div>
    {#each cells as c (c.key)}
      <div class="osmm-week-head" class:is-today={c.isToday} role="columnheader">
        {new Date(c.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
      </div>
    {/each}
    <div class="osmm-hours" style:height="{24 * 60 * PX_PER_MINUTE}px">
      {#each HOURS as h (h)}<span class="osmm-hour" style:top="{h * 60 * PX_PER_MINUTE}px">{String(h).padStart(2, "0")}:00</span>{/each}
    </div>
    {#each cells as c (c.key)}
      <div
        class="osmm-week-col"
        role="gridcell"
        data-day={c.key}
        style:height="{24 * 60 * PX_PER_MINUTE}px"
        tabindex="-1"
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => actions.dropOnSlot(e, c.date, Math.round(e.offsetY / PX_PER_MINUTE / 15) * 15)}>
        {#if c.isToday}<div class="osmm-now-line" style:top="{minutesOfDay($now) * PX_PER_MINUTE}px"></div>{/if}
        {#each layoutDay(byDay.get(c.key) ?? []) as p (p.row.key)}
          <div
            class="osmm-week-item"
            data-row-key={p.row.key}
            style:top="{p.top * PX_PER_MINUTE}px"
            style:left="{(p.lane / p.lanes) * 100}%"
            style:width="{100 / p.lanes}%">
            <Chip row={p.row} />
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
