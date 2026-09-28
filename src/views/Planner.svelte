<script lang="ts">
  import { get } from "svelte/store";
  import { expandRows, filterRows, rowsBetween } from "../index/queries";
  import { monthRange, shiftMonth } from "../planner/calendar";
  import { toRowFilter, type PlannerMode } from "../planner/viewState";
  import { useOsmm } from "../ui/context";
  import { monthTitle } from "../ui/format";
  import { icon } from "../ui/icon";
  import FilterBar from "./FilterBar.svelte";
  import Legend from "./Legend.svelte";
  import MonthView from "./MonthView.svelte";
  import ViewSwitcher from "./ViewSwitcher.svelte";

  const { snapshot, settings, viewState, channels, now } = useOsmm();
  const MODES: PlannerMode[] = ["month"];

  const start = new Date(get(now));
  let cursor = $state({ year: start.getFullYear(), month: start.getMonth() });

  const mode = $derived(MODES.includes($viewState.mode) ? $viewState.mode : "month");
  const knownCampaigns = $derived(new Set(["", ...$snapshot.campaigns.map((c) => c.path)]));
  const filter = $derived({ ...$viewState.filter, campaigns: $viewState.filter.campaigns.filter((p) => knownCampaigns.has(p)) });
  const rows = $derived(filterRows(expandRows($snapshot.variants, $settings.defaultStaggerMinutes), toRowFilter(filter, channels)));
  const range = $derived(monthRange(cursor.year, cursor.month, $settings.weekStartsOn));
  const visible = $derived(rowsBetween(rows, range.from, range.to));

  function step(delta: number): void {
    cursor = shiftMonth(cursor.year, cursor.month, delta);
  }
  function today(): void {
    const d = new Date($now);
    cursor = { year: d.getFullYear(), month: d.getMonth() };
  }
  function setMode(next: PlannerMode): void {
    viewState.update((s) => ({ ...s, mode: next }));
  }
</script>

<div class="osmm-planner">
  <header class="osmm-toolbar">
    <h2 class="osmm-title">{monthTitle(cursor.year, cursor.month)}</h2>
    <div class="osmm-nav">
      <button type="button" aria-label="Previous" onclick={() => step(-1)}><span use:icon={"chevron-left"}></span></button>
      <button type="button" aria-label="Next" onclick={() => step(1)}><span use:icon={"chevron-right"}></span></button>
      <button type="button" onclick={today}>Today</button>
    </div>
    <div class="osmm-spacer"></div>
    <ViewSwitcher modes={MODES} value={mode} onchange={setMode} />
  </header>
  <div class="osmm-subbar">
    <FilterBar />
    <div class="osmm-spacer"></div>
    <Legend />
  </div>
  <div class="osmm-body">
    {#if mode === "month"}
      <MonthView year={cursor.year} month={cursor.month} rows={visible} />
    {/if}
  </div>
</div>
