<script lang="ts">
  import { Menu } from "obsidian";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { FILTERABLE_STATUSES, STATUS_LABEL } from "../planner/status";
  import { EMPTY_FILTER, activeFilterCount, toggle, type PlannerFilter } from "../planner/viewState";
  import { useOsmm } from "../ui/context";

  type Item = { title: string; checked: boolean; onClick: () => void } | "separator";

  const { viewState, snapshot, channels } = useOsmm();
  const filter = $derived($viewState.filter);

  function update(patch: Partial<PlannerFilter>): void {
    viewState.update((s) => ({ ...s, filter: { ...s.filter, ...patch } }));
  }

  function show(event: MouseEvent, items: Item[]): void {
    const menu = new Menu();
    for (const it of items) {
      if (it === "separator") menu.addSeparator();
      else menu.addItem((i) => i.setTitle(it.title).setChecked(it.checked).onClick(it.onClick));
    }
    menu.showAtMouseEvent(event);
  }

  function platformMenu(event: MouseEvent): void {
    show(
      event,
      PLATFORMS.map((p) => ({
        title: PLATFORM_META[p].label,
        checked: filter.platforms.includes(p),
        onClick: () => update({ platforms: toggle(filter.platforms, p) }),
      })),
    );
  }

  function channelMenu(event: MouseEvent): void {
    const groups: Item[] = channels.groups().map((g) => ({
      title: `${g.name} (group)`,
      checked: filter.channels.includes(`group:${g.id}`),
      onClick: () => update({ channels: toggle(filter.channels, `group:${g.id}`) }),
    }));
    const list: Item[] = channels.list().map((c) => ({
      title: `${PLATFORM_META[c.platform].label} · ${c.name}`,
      checked: filter.channels.includes(c.id),
      onClick: () => update({ channels: toggle(filter.channels, c.id) }),
    }));
    show(event, groups.length ? [...groups, "separator", ...list] : list);
  }

  function campaignMenu(event: MouseEvent): void {
    show(event, [
      { title: "Standalone posts", checked: filter.campaigns.includes(""), onClick: () => update({ campaigns: toggle(filter.campaigns, "") }) },
      "separator",
      ...$snapshot.campaigns.map((c) => ({
        title: c.title,
        checked: filter.campaigns.includes(c.path),
        onClick: () => update({ campaigns: toggle(filter.campaigns, c.path) }),
      })),
    ]);
  }

  function statusMenu(event: MouseEvent): void {
    show(
      event,
      FILTERABLE_STATUSES.map((s) => ({
        title: STATUS_LABEL[s],
        checked: filter.statuses.includes(s),
        onClick: () => update({ statuses: toggle(filter.statuses, s) }),
      })),
    );
  }

  const label = (name: string, n: number) => (n ? `${name} (${n})` : name);
</script>

<div class="osmm-filterbar" role="toolbar" aria-label="Filters">
  <button type="button" onclick={platformMenu}>{label("Platform", filter.platforms.length)}</button>
  <button type="button" onclick={channelMenu}>{label("Channel", filter.channels.length)}</button>
  <button type="button" onclick={campaignMenu}>{label("Campaign", filter.campaigns.length)}</button>
  <button type="button" onclick={statusMenu}>{label("Status", filter.statuses.length)}</button>
  {#if activeFilterCount(filter) > 0}
    <button type="button" class="mod-warning" onclick={() => update(EMPTY_FILTER)}>Clear filters</button>
  {/if}
</div>
