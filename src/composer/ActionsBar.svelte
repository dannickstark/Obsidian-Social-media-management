<script lang="ts">
  import { Menu } from "obsidian";
  import type { IndexedVariant } from "../index/socialIndex";
  import type { Issue } from "../model/types";
  import { blocking } from "../platforms/checks";
  import { useOsmm } from "../ui/context";

  let { variant, issues = [] }: { variant: IndexedVariant; issues?: Issue[] } = $props();
  const { channels, composer, publish } = useOsmm();
  const blocked = $derived(blocking(issues));

  function forkMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const id of variant.channels) {
      menu.addItem((item) => item.setTitle(channels.get(id)?.name ?? id).onClick(() => void composer.fork(variant, id)));
    }
    menu.showAtMouseEvent(event);
  }
</script>

<section class="osmm-panel" aria-label="Actions">
  <div class="osmm-chips">
    <button type="button" class="mod-cta" disabled={blocked} onclick={() => void publish.postNow(variant.path, undefined, { fromComposer: true })}>Post now</button>
    <button type="button" disabled={blocked} onclick={() => publish.openAssisted(variant.path)}>Copy & open</button>
    {#if variant.channels.length > 1}<button type="button" onclick={forkMenu}>Fork for this page…</button>{/if}
    {#if variant.campaignPath}
      <button type="button" onclick={() => void composer.openPreviewGrid(variant.campaignPath!)}>Preview campaign</button>
    {/if}
  </div>
</section>
