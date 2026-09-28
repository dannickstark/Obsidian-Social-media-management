<script lang="ts">
  import type { PreviewAuthor } from "./model";

  let { author, meta = "" }: { author: PreviewAuthor; meta?: string } = $props();
</script>

<div class="osmm-pv-head">
  <span class="osmm-pv-avatar" class:is-round={author.round} style:--osmm-avatar={author.color} aria-hidden="true">{author.initials}</span>
  <span class="osmm-pv-who">
    <strong>{author.name}</strong>
    {#if author.handle}<span class="osmm-pv-handle">{author.handle}</span>{/if}
  </span>
  {#if meta}<span class="osmm-pv-meta">{meta}</span>{/if}
</div>
