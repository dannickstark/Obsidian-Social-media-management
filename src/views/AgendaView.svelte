<script lang="ts">
  import type { PostRow } from "../index/queries";
  import { agendaDays } from "../planner/agenda";
  import { useOsmm } from "../ui/context";
  import { formatShortDate } from "../ui/format";
  import Chip from "./Chip.svelte";

  let { rows, from, to }: { rows: PostRow[]; from: number; to: number } = $props();
  const { now } = useOsmm();
  const days = $derived(agendaDays(rows, from, to, $now));
</script>

<ol class="osmm-agenda" aria-label="Agenda">
  {#each days as day (day.key)}
    <li class="osmm-agenda-day" class:is-today={day.isToday}>
      <h3 class="osmm-agenda-date">{day.isToday ? "Today · " : ""}{formatShortDate(day.date)}</h3>
      {#each day.rows as row (row.key)}
        <Chip {row} />
      {:else}
        <p class="osmm-progress">Nothing planned.</p>
      {/each}
    </li>
  {:else}
    <li class="osmm-progress">Nothing planned in this period.</li>
  {/each}
</ol>
