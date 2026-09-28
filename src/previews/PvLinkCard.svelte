<script lang="ts">
  import { getContext } from "svelte";
  import type { LinkCard } from "../platforms/og";
  import { OSMM_KEY, type OsmmContext } from "../ui/context";

  /** Only http(s) links are ever rendered as clickable; javascript:, data:, vbscript:, relative and obsidian: links render as plain text. */
  const SAFE_URL_RE = /^https?:\/\//i;
  /** Fix round 1 (#93): don't fetch on every keystroke while the composer's url field is still being typed. */
  const FETCH_DEBOUNCE_MS = 800;
  /** A host that at least looks finished: a dot followed by 2+ letters, e.g. "example.com" but not "localhost" or "example.c". */
  const TLD_RE = /\.[a-z]{2,}$/i;

  let { card }: { card: { url: string; domain: string } } = $props();
  // Previews also render outside the plugin (tests); there is simply no fetched card then.
  const ctx = getContext<OsmmContext | undefined>(OSMM_KEY);
  const safe = $derived(SAFE_URL_RE.test(card.url));
  let fetched = $state<LinkCard | null>(null);

  /** Worth fetching: http(s), and its host looks like a finished domain rather than mid-typing or a bare "localhost". */
  function looksFetchable(url: string): boolean {
    if (!SAFE_URL_RE.test(url)) return false;
    try {
      return TLD_RE.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  $effect(() => {
    const url = card.url;
    const cards = ctx?.linkCards;
    fetched = cards?.peek(url) ?? null;
    if (!cards || !looksFetchable(url)) return;
    let live = true;
    // Debounced: a url that keeps changing (still being typed) never fires a fetch until it holds still.
    const handle = window.setTimeout(() => {
      void cards.get(url).then((c) => {
        if (live) fetched = c;
      });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(handle);
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
