<script lang="ts">
  import { getContext } from "svelte";
  import type { LinkCard } from "../platforms/og";
  import { OSMM_KEY, type OsmmContext } from "../ui/context";

  /** Only http(s) links are ever rendered as clickable; javascript:, data:, vbscript:, relative and obsidian: links render as plain text. */
  const SAFE_URL_RE = /^https?:\/\//i;

  let { card }: { card: { url: string; domain: string } } = $props();
  // Previews also render outside the plugin (tests); there is simply no fetched card then.
  const ctx = getContext<OsmmContext | undefined>(OSMM_KEY);
  const safe = $derived(SAFE_URL_RE.test(card.url));
  let fetched = $state<LinkCard | null>(null);

  $effect(() => {
    const url = card.url;
    const cards = ctx?.linkCards;
    fetched = cards?.peek(url) ?? null;
    if (!cards || !SAFE_URL_RE.test(url)) return;
    let live = true;
    void cards.get(url).then((c) => {
      if (live) fetched = c;
    });
    return () => {
      live = false;
    };
  });

  const image = $derived(fetched?.image && SAFE_URL_RE.test(fetched.image) ? fetched.image : null);
</script>

{#if safe}
  <a class="osmm-pv-card" href={card.url} target="_blank" rel="noopener">
    {#if image}<img class="osmm-pv-card-image" src={image} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
    <span class="osmm-pv-card-domain">{card.domain}</span>
    {#if fetched?.title}<span class="osmm-pv-card-title">{fetched.title}</span>{/if}
    {#if fetched?.description}<span class="osmm-pv-card-desc">{fetched.description}</span>{/if}
    <span class="osmm-pv-card-url">{card.url}</span>
  </a>
{:else}
  <div class="osmm-pv-card">
    <span class="osmm-pv-card-domain">{card.domain}</span>
    <span class="osmm-pv-card-url">{card.url}</span>
  </div>
{/if}
