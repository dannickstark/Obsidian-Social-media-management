<script lang="ts">
  import { Menu } from "obsidian";
  import { PLATFORM_META } from "../model/platforms";
  import { campaignTable } from "../planner/campaignTable";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import { formatShortDate, formatTime } from "../ui/format";
  import Timeline from "./Timeline.svelte";

  let { campaignPath }: { campaignPath: string } = $props();
  const { snapshot, settings, actions, composer } = useOsmm();
  const table = $derived(campaignTable(campaignPath, $snapshot.variants, $settings.channels));
  const campaign = $derived($snapshot.campaigns.find((c) => c.path === campaignPath));
  const STATUS: Record<string, string> = { idea: "Idea", draft: "Draft", ready: "Ready", scheduled: "Scheduled", partial: "Partly published", published: "Published", overdue: "Overdue", attention: "Needs attention", skipped: "Skipped" };

  function templateMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const t of $settings.scheduleTemplates) menu.addItem((i) => i.setTitle(t.name).onClick(() => actions.openTemplatePreview(campaignPath, t.id)));
    menu.showAtMouseEvent(event);
  }
</script>

<section class="osmm-variants" aria-label="Platform variants">
  <header class="osmm-variants-head">
    <strong>Platform variants</strong>
    <span class="osmm-progress">{table.counts.created} created · {table.counts.published} published · {table.counts.overdue} overdue</span>
    <span class="osmm-spacer"></span>
    <button type="button" onclick={() => void composer.openPreviewGrid(campaignPath)}>Preview all</button>
    <button type="button" onclick={templateMenu}>Apply schedule template</button>
  </header>
  <table class="osmm-table">
    <thead>
      <tr><th>Platform</th><th>Channels</th><th>Mode</th><th>Scheduled</th><th>Length</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr>
    </thead>
    <tbody>
      {#each table.rows as r (r.variant.path)}
        <tr>
          <td><span class="osmm-row"><PlatformBadge platform={r.variant.platform} size="md" />{PLATFORM_META[r.variant.platform].label}</span></td>
          <td><span class="osmm-row">{#each r.channels as c (c.id)}<ChannelAvatar channel={c} size={20} />{/each}</span></td>
          <td>{r.variant.mode === "assisted" ? "Assisted" : "Auto-post"}</td>
          <td>{r.when !== undefined ? `${formatShortDate(r.when)} ${formatTime(r.when)}` : "—"}</td>
          <td class="osmm-progress">{r.chars}</td>
          <td><span class="osmm-pill-status">{STATUS[r.status] ?? r.status}</span></td>
          <td>
            <button type="button" onclick={() => actions.openNote(r.variant.path)}>Open</button>
            <button type="button" aria-label={`Compose ${PLATFORM_META[r.variant.platform].label} variant`} onclick={() => void composer.openComposer(r.variant.path)}>Compose</button>
          </td>
        </tr>
      {/each}
      {#each table.missing as p (p)}
        <tr class="is-missing">
          <td><span class="osmm-row"><PlatformBadge platform={p} size="md" />{PLATFORM_META[p].label}</span></td>
          <td colspan="5" class="osmm-progress">not created</td>
          <td><button type="button" aria-label={`Create ${PLATFORM_META[p].label} variant`} onclick={() => void actions.createVariantForCampaign(campaignPath, p)}>Create variant</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if campaign?.anchorDate !== undefined}
    <Timeline anchor={campaign.anchorDate} variants={table.rows.map((r) => r.variant)} />
  {/if}
</section>
