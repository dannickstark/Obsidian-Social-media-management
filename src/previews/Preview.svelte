<script lang="ts">
  import type { PreviewModel } from "./model";
  import ArticlePreview from "./ArticlePreview.svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import FeedPreview from "./FeedPreview.svelte";
  import LinkPreview from "./LinkPreview.svelte";

  let { model, width = "mobile" }: { model: PreviewModel; width?: "mobile" | "desktop" } = $props();
</script>

<figure class="osmm-preview" data-width={width} data-platform={model.platform} aria-label={`${model.label} preview`}>
  {#if model.layout === "chat"}
    <ChatPreview {model} />
  {:else if model.layout === "link"}
    <LinkPreview {model} />
  {:else if model.layout === "article"}
    <ArticlePreview {model} />
  {:else}
    <FeedPreview {model} />
  {/if}
</figure>
