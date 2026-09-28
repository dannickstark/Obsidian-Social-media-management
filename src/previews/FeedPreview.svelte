<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvHeader from "./PvHeader.svelte";
  import PvLinkCard from "./PvLinkCard.svelte";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  let expanded = $state(false);
  const posts = $derived(model.items.length ? model.items : [{ segments: [], chars: 0, limit: 0, over: false }]);
  const numbered = $derived(model.layout === "thread" && model.items.length > 1);
  const mediaFirst = $derived(model.platform === "instagram");
</script>

<article class="osmm-pv-feed" data-layout={model.layout}>
  {#each posts as item, i (i)}
    <div class="osmm-pv-post" class:is-reply={i > 0}>
      <PvHeader author={model.author} meta={numbered ? `${i + 1}/${model.items.length}` : "now"} />
      {#if i === 0 && mediaFirst}<PvMedia media={model.media} />{/if}
      {#if i === 0 && model.fold && !expanded}
        <PvText segments={model.fold} />
        <button type="button" class="osmm-pv-more" aria-expanded={expanded} onclick={() => (expanded = true)}>…see more</button>
      {:else}
        <PvText segments={item.segments} />
      {/if}
      {#if i === 0 && !mediaFirst}<PvMedia media={model.media} />{/if}
      {#if i === 0 && model.linkCard}<PvLinkCard card={model.linkCard} />{/if}
      {#if item.over}<p class="osmm-pv-over" role="status">{item.chars}/{item.limit} characters</p>{/if}
    </div>
  {/each}
</article>
