<script lang="ts">
  import { Menu } from "obsidian";
  import type { IndexedVariant } from "../index/socialIndex";
  import { useOsmm } from "../ui/context";

  let { variant }: { variant: IndexedVariant } = $props();
  const { channels, composer } = useOsmm();

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
    {#if variant.channels.length > 1}<button type="button" onclick={forkMenu}>Fork for this page…</button>{/if}
    {#if variant.campaignPath}
      <button type="button" onclick={() => void composer.openPreviewGrid(variant.campaignPath!)}>Preview campaign</button>
    {/if}
  </div>
</section>
