<script lang="ts">
  import { articleBlocks, type PreviewModel } from "./model";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  const blocks = $derived(articleBlocks(model.markdown, model.title));
</script>

<article class="osmm-pv-article">
  <div class="osmm-pv-site">{model.author.name}</div>
  {#if model.featured}<PvMedia media={[model.featured]} />{/if}
  <h1 class="osmm-pv-article-title">{model.title ?? "Untitled"}</h1>
  {#if model.excerpt}<p class="osmm-pv-excerpt">{model.excerpt}</p>{/if}
  {#each blocks as block, i (i)}
    {#if block.kind === "heading"}
      <svelte:element this={`h${Math.min(block.level + 1, 6)}`} class="osmm-pv-h"><PvText segments={block.segments} inline /></svelte:element>
    {:else if block.kind === "paragraph"}
      <PvText segments={block.segments} />
    {:else if block.kind === "list"}
      <svelte:element this={block.ordered ? "ol" : "ul"}>
        {#each block.items as item, j (j)}<li><PvText segments={item} inline /></li>{/each}
      </svelte:element>
    {:else if block.kind === "quote"}
      <blockquote><PvText segments={block.segments} /></blockquote>
    {:else if block.kind === "rule"}
      <hr />
    {:else if model.embeds?.[block.target]}
      <img class="osmm-pv-inline-img" src={model.embeds[block.target]} alt="" />
    {:else}
      <div class="osmm-pv-tile is-missing" role="img" aria-label={`${block.target} is not shown`}>{block.target}</div>
    {/if}
  {/each}
</article>
