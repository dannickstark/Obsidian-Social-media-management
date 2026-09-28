<script lang="ts">
  import type { Readable } from "svelte/store";
  import type { LoadedContent } from "../composer/content";
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { VARIANT_STATUS_LABEL } from "../planner/status";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import Preview from "./Preview.svelte";

  let { campaign }: { campaign: Readable<string | null> } = $props();
  const { snapshot, composer, actions } = useOsmm();

  let path = $state<string | null>(null);
  $effect(() => campaign.subscribe((p) => (path = p)));

  const byPlatform = (a: IndexedVariant, b: IndexedVariant) =>
    PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.path.localeCompare(b.path);
  const title = $derived($snapshot.campaigns.find((c) => c.path === path)?.title ?? "Campaign");
  const variants = $derived(path ? $snapshot.variants.filter((v) => v.campaignPath === path).sort(byPlatform) : []);

  let loaded = $state(new Map<string, LoadedContent>());
  $effect(() => {
    const list = variants;
    let cancelled = false;
    void Promise.all(list.map(async (v) => [v.path, await composer.content.load(v)] as const)).then((entries) => {
      if (!cancelled) loaded = new Map(entries);
    });
    return () => {
      cancelled = true;
    };
  });

  const cards = $derived(
    variants.map((v) => {
      const content = loaded.get(v.path);
      return content
        ? { v, issues: composer.check(v, content), counters: composer.counters(v, content), model: composer.preview(v, content) }
        : { v, issues: [], counters: [], model: null };
    }),
  );
  const blocked = $derived(cards.filter((c) => c.issues.some((i) => i.level === "error")).length);
  const warnings = $derived(cards.reduce((n, c) => n + c.issues.filter((i) => i.level === "warning").length, 0));
  const ready = $derived(variants.filter((v) => v.status === "ready"));
</script>

<div class="osmm-grid-view">
  <header class="osmm-toolbar">
    <h2 class="osmm-title">{title}</h2>
    <span class="osmm-progress">{variants.length} variants · {blocked} blocked · {warnings} warnings</span>
    <span class="osmm-spacer"></span>
    <button type="button" class="mod-cta" disabled={ready.length === 0} onclick={() => void composer.approveReady(ready)}>Approve all ready ({ready.length})</button>
  </header>
  {#if !path}
    <p class="osmm-empty">Open a campaign to preview its variants.</p>
  {:else if !variants.length}
    <p class="osmm-empty">This campaign has no variants yet.</p>
  {/if}
  <div class="osmm-grid">
    {#each cards as card (card.v.path)}
      <section class="osmm-grid-card" aria-label={`${PLATFORM_META[card.v.platform].label} variant`}>
        <header class="osmm-row">
          <PlatformBadge platform={card.v.platform} size="md" />
          <strong class="osmm-row-title">{PLATFORM_META[card.v.platform].label}</strong>
          <span class="osmm-pill-status">{VARIANT_STATUS_LABEL[card.v.status]}</span>
        </header>
        <div class="osmm-grid-counters">
          {#each card.counters as c (c.label)}
            <span class="osmm-progress" class:is-over={c.value > c.limit && c.label !== "Fold"}>{c.label} {c.value.toLocaleString()}/{c.limit.toLocaleString()}</span>
          {/each}
        </div>
        {#if card.issues.length}
          <ul class="osmm-issue-list">
            {#each card.issues as issue, i (i)}<li class={issue.level === "error" ? "is-error" : "is-warning"}>{issue.message}</li>{/each}
          </ul>
        {/if}
        {#if card.model}<Preview model={card.model} />{:else}<p class="osmm-progress">Loading…</p>{/if}
        <footer class="osmm-row">
          <button type="button" onclick={() => actions.openNote(card.v.path)}>Open note</button>
          <button type="button" onclick={() => void composer.openComposer(card.v.path)}>Compose</button>
          {#each composer.cardActions as action (action.label)}<button type="button" onclick={() => action.run(card.v)}>{action.label}</button>{/each}
        </footer>
      </section>
    {/each}
  </div>
</div>
