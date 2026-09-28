<script lang="ts">
  let { card }: { card: { url: string; domain: string } } = $props();
</script>

<a class="osmm-pv-card" href={card.url} target="_blank" rel="noopener">
  <span class="osmm-pv-card-domain">{card.domain}</span>
  <span class="osmm-pv-card-url">{card.url}</span>
</a>
