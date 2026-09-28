<script lang="ts">
  /** Only http(s) links are ever rendered as clickable; javascript:, data:, vbscript:, relative and obsidian: links render as plain text. */
  const SAFE_URL_RE = /^https?:\/\//i;

  let { card }: { card: { url: string; domain: string } } = $props();
  const safe = $derived(SAFE_URL_RE.test(card.url));
</script>

{#if safe}
  <a class="osmm-pv-card" href={card.url} target="_blank" rel="noopener">
    <span class="osmm-pv-card-domain">{card.domain}</span>
    <span class="osmm-pv-card-url">{card.url}</span>
  </a>
{:else}
  <div class="osmm-pv-card">
    <span class="osmm-pv-card-domain">{card.domain}</span>
    <span class="osmm-pv-card-url">{card.url}</span>
  </div>
{/if}
