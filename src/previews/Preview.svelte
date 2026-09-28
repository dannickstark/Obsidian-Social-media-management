<script lang="ts">
  import type { PreviewModel } from "./model";
  import FeedPreview from "./FeedPreview.svelte";

  let { model, width = "mobile" }: { model: PreviewModel; width?: "mobile" | "desktop" } = $props();
</script>

<figure class="osmm-preview" data-width={width} data-platform={model.platform} aria-label={`${model.label} preview`}>
  <FeedPreview {model} />
</figure>
