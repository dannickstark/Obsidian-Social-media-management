<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { VARIANT_STATUS_LABEL } from "../planner/status";
  import type { MediaInfo } from "../platforms/types";
  import Preview from "../previews/Preview.svelte";
  import PlatformBadge from "../ui/PlatformBadge.svelte";
  import { useOsmm } from "../ui/context";
  import Checks from "./Checks.svelte";
  import PostAs from "./PostAs.svelte";
  import SchedulePanel from "./SchedulePanel.svelte";
  import type { ComposerSession } from "./session";

  let { session, openVariant }: { session: ComposerSession; openVariant: (path: string) => void } = $props();
  const { snapshot, composer } = useOsmm();

  let path = $state<string | null>(null);
  let body = $state("");
  $effect(() => session.path.subscribe((p) => (path = p)));
  $effect(() => session.body.subscribe((b) => (body = b)));

  const byPlatform = (a: IndexedVariant, b: IndexedVariant) =>
    PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.path.localeCompare(b.path);
  const variant = $derived($snapshot.variants.find((v) => v.path === path));
  const siblings = $derived(
    variant?.campaignPath ? $snapshot.variants.filter((v) => v.campaignPath === variant.campaignPath).sort(byPlatform) : variant ? [variant] : [],
  );

  let media = $state<MediaInfo[]>([]);
  let featured = $state<MediaInfo | undefined>(undefined);
  $effect(() => {
    const v = variant;
    if (!v) return;
    let cancelled = false;
    void composer.content.load(v).then((c) => {
      if (cancelled) return;
      media = c.media;
      featured = c.featured;
    });
    return () => {
      cancelled = true;
    };
  });
  const content = $derived({ body, media, featured });

  const variantChannels = $derived(variant ? composer.channelsOf(variant) : []);
  let previewChannelId = $state("");
  $effect(() => {
    if (variant && !variant.channels.includes(previewChannelId)) previewChannelId = variant.channels[0] ?? "";
  });
  const previewChannel = $derived(variantChannels.find((c) => c.id === previewChannelId) ?? variantChannels[0]);
  let width = $state<"mobile" | "desktop">("mobile");
  const model = $derived(variant ? composer.preview(variant, content, previewChannel) : null);
  const issues = $derived(variant ? composer.check(variant, content) : []);
  const counterList = $derived(variant ? composer.counters(variant, content, previewChannel) : []);
</script>

{#if !variant}
  <div class="osmm-composer-empty">
    <p>Open a social post note to compose it here.</p>
  </div>
{:else}
  <div class="osmm-composer">
    <div class="osmm-tabs" role="tablist" aria-label="Platforms">
      {#each siblings as s (s.path)}
        <button type="button" role="tab" aria-selected={s.path === variant.path} onclick={() => openVariant(s.path)}>
          <PlatformBadge platform={s.platform} />{PLATFORM_META[s.platform].label}
        </button>
      {/each}
    </div>
    <div class="osmm-composer-main">
      <section class="osmm-composer-preview" aria-label="Preview">
        <div class="osmm-row">
          {#if variantChannels.length > 1}
            <label class="osmm-row">
              Preview as
              <select bind:value={previewChannelId}>
                {#each variantChannels as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
              </select>
            </label>
          {/if}
          <span class="osmm-spacer"></span>
          <div class="osmm-segmented" role="group" aria-label="Preview width">
            <button type="button" class:is-active={width === "mobile"} aria-pressed={width === "mobile"} onclick={() => (width = "mobile")}>Mobile</button>
            <button type="button" class:is-active={width === "desktop"} aria-pressed={width === "desktop"} onclick={() => (width = "desktop")}>Desktop</button>
          </div>
        </div>
        <div class="osmm-phone" data-width={width}>
          {#if model}<Preview {model} {width} />{/if}
        </div>
      </section>
      <aside class="osmm-composer-side" aria-label="Composer panels">
        <p class="osmm-progress">{PLATFORM_META[variant.platform].label} · {VARIANT_STATUS_LABEL[variant.status]}</p>
        <PostAs {variant} />
        <Checks {variant} {issues} counters={counterList} />
        <SchedulePanel {variant} {issues} />
      </aside>
    </div>
  </div>
{/if}
