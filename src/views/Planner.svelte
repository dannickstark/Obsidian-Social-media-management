<script lang="ts">
  import { get } from "svelte/store";
  import { expandRows, filterRows, rowsBetween } from "../index/queries";
  import { monthRange, weekCells, weekRange } from "../planner/calendar";
  import { toRowFilter, type PlannerMode } from "../planner/viewState";
  import { addLocalDays, startOfLocalDay } from "../model/dates";
  import { useOsmm } from "../ui/context";
  import { monthTitle, weekTitle } from "../ui/format";
  import { icon } from "../ui/icon";
  import BoardView from "./BoardView.svelte";
  import FilterBar from "./FilterBar.svelte";
  import Legend from "./Legend.svelte";
  import ListView from "./ListView.svelte";
  import MonthView from "./MonthView.svelte";
  import PublisherBanner from "./PublisherBanner.svelte";
  import ViewSwitcher from "./ViewSwitcher.svelte";
  import WeekView from "./WeekView.svelte";

  const { snapshot, settings, viewState, channels, now } = useOsmm();
  const MODES: PlannerMode[] = ["month", "week", "board", "list"];

  let anchor = $state(startOfLocalDay(get(now)));
  const mode = $derived(MODES.includes($viewState.mode) ? $viewState.mode : "month");
  const year = $derived(new Date(anchor).getFullYear());
  const month = $derived(new Date(anchor).getMonth());

  const knownCampaigns = $derived(new Set(["", ...$snapshot.campaigns.map((c) => c.path)]));
  const filter = $derived({ ...$viewState.filter, campaigns: $viewState.filter.campaigns.filter((p) => knownCampaigns.has(p)) });
  const rows = $derived(filterRows(expandRows($snapshot.variants, $settings.defaultStaggerMinutes), toRowFilter(filter, channels)));
  const range = $derived(mode === "week" ? weekRange(anchor, $settings.weekStartsOn) : monthRange(year, month, $settings.weekStartsOn));
  const visible = $derived(rowsBetween(rows, range.from, range.to));
  const boardVariants = $derived.by(() => {
    const keep = new Set(rows.map((r) => r.variant.path));
    return $snapshot.variants.filter((v) => keep.has(v.path));
  });
  const title = $derived.by(() => {
    if (mode === "board") return "Pipeline";
    if (mode === "list") return "All posts";
    if (mode !== "week") return monthTitle(year, month);
    const cells = weekCells(anchor, $settings.weekStartsOn, 0);
    return weekTitle(cells[0]!.date, cells[6]!.date);
  });

  function step(delta: number): void {
    if (mode === "week") anchor = addLocalDays(anchor, 7 * delta);
    else anchor = new Date(year, month + delta, 1).getTime();
  }
  function today(): void {
    anchor = startOfLocalDay($now);
  }
  function setMode(next: PlannerMode): void {
    viewState.update((s) => ({ ...s, mode: next }));
  }
</script>

<div class="osmm-planner">
  <header class="osmm-toolbar">
    <h2 class="osmm-title">{title}</h2>
    {#if mode === "month" || mode === "week"}
      <div class="osmm-nav">
        <button type="button" aria-label="Previous" onclick={() => step(-1)}><span use:icon={"chevron-left"}></span></button>
        <button type="button" aria-label="Next" onclick={() => step(1)}><span use:icon={"chevron-right"}></span></button>
        <button type="button" onclick={today}>Today</button>
      </div>
    {/if}
    <div class="osmm-spacer"></div>
    <ViewSwitcher modes={MODES} value={mode} onchange={setMode} />
  </header>
  <div class="osmm-subbar">
    <FilterBar />
    <div class="osmm-spacer"></div>
    <Legend />
  </div>
  <PublisherBanner />
  <div class="osmm-body">
    {#if mode === "month"}
      <MonthView {year} {month} rows={visible} />
    {:else if mode === "week"}
      <WeekView {anchor} rows={visible} />
    {:else if mode === "board"}
      <BoardView variants={boardVariants} />
    {:else if mode === "list"}
      <ListView {rows} />
    {/if}
  </div>
</div>
