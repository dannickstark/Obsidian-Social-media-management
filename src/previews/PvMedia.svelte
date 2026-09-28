<script lang="ts">
  import { objectPosition, type PreviewMedia } from "./model";

  let { media }: { media: PreviewMedia[] } = $props();
  const shown = $derived(media.slice(0, 4));
</script>

{#if shown.length}
  <div class="osmm-pv-media" data-count={shown.length}>
    {#each shown as m (m.target)}
      {#if m.kind === "image" && m.src}
        <div class="osmm-pv-tile" style:aspect-ratio={shown.length === 1 && m.crop ? String(m.crop.ratio) : null}>
          <img src={m.src} alt={m.alt ?? ""} style:object-position={m.crop ? objectPosition(m.crop) : null} />
        </div>
      {:else}
        <div class="osmm-pv-tile is-missing" role="img" aria-label={`${m.target} is not shown`}>{m.target}</div>
      {/if}
    {/each}
  </div>
{/if}
