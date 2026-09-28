<script lang="ts">
  import type { Segment } from "./model";

  let { segments, inline = false }: { segments: Segment[]; inline?: boolean } = $props();
</script>

<svelte:element this={inline ? "span" : "p"} class="osmm-pv-text">{#each segments as s, i (i)}{#if s.href}<a class="osmm-pv-link" href={s.href} target="_blank" rel="noopener">{s.text}</a>{:else if s.tag}<span class="osmm-pv-tag">{s.text}</span>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else if s.strike}<s>{s.text}</s>{:else if s.code}<code>{s.text}</code>{:else}{s.text}{/if}{/each}</svelte:element>
