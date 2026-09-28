<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
</script>

<article class="osmm-pv-link" data-platform={model.platform}>
  {#if model.platform === "reddit"}<div class="osmm-pv-sub">{model.author.handle ?? model.author.name} · posted by you</div>{/if}
  <h4 class="osmm-pv-title">{model.title ?? "Untitled"}{#if model.domain}{" "}<span class="osmm-pv-domain">({model.domain})</span>{/if}</h4>
  {#if model.platform === "hackernews"}<div class="osmm-pv-meta">1 point by you · just now</div>{/if}
  {#each model.items as item, i (i)}<PvText segments={item.segments} />{/each}
  <PvMedia media={model.media} />
</article>
