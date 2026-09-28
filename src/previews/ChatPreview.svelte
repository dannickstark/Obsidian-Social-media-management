<script lang="ts">
  import type { PreviewModel } from "./model";
  import PvHeader from "./PvHeader.svelte";
  import PvLinkCard from "./PvLinkCard.svelte";
  import PvMedia from "./PvMedia.svelte";
  import PvText from "./PvText.svelte";

  let { model }: { model: PreviewModel } = $props();
  const over = $derived(model.items.filter((i) => i.over));
</script>

<article class="osmm-pv-chat" data-platform={model.platform}>
  {#if model.platform === "discord"}<PvHeader author={model.author} meta="Today" />{/if}
  <div class="osmm-pv-bubble">
    {#if model.platform === "telegram"}<strong class="osmm-pv-channel">{model.author.name}</strong>{/if}
    <PvMedia media={model.media} />
    {#each model.items as item, i (i)}<PvText segments={item.segments} />{/each}
    {#if model.linkCard}<PvLinkCard card={model.linkCard} />{/if}
    <span class="osmm-pv-time">now</span>
  </div>
  {#each over as item, i (i)}<p class="osmm-pv-over" role="status">{item.chars}/{item.limit} characters</p>{/each}
</article>
