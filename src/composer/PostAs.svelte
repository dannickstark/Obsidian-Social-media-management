<script lang="ts">
  import type { IndexedVariant } from "../index/socialIndex";
  import { PLATFORM_META } from "../model/platforms";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import { useOsmm } from "../ui/context";

  let { variant }: { variant: IndexedVariant } = $props();
  const { settings, composer } = useOsmm();
  const options = $derived($settings.channels.filter((c) => c.platform === variant.platform));
  const groups = $derived($settings.channelGroups.filter((g) => g.channelIds.some((id) => options.some((c) => c.id === id))));
  const unknown = $derived(variant.channels.filter((id) => !options.some((c) => c.id === id)));
</script>

<section class="osmm-panel" aria-label="Post as">
  <h4 class="osmm-section-title">Post as</h4>
  <div class="osmm-chips">
    {#each options as c (c.id)}
      {@const on = variant.channels.includes(c.id)}
      <button type="button" class="osmm-toggle" aria-pressed={on} aria-label={c.name} onclick={() => void composer.toggleChannel(variant, c, !on)}>
        <ChannelAvatar channel={c} size={18} />{c.name}
      </button>
    {:else}
      <p class="osmm-progress">No {PLATFORM_META[variant.platform].label} channels yet. Add one in settings.</p>
    {/each}
  </div>
  {#if unknown.length}<p class="osmm-progress">Not in settings: {unknown.join(", ")}</p>{/if}
  {#if groups.length}
    <div class="osmm-chips">
      {#each groups as g (g.id)}<button type="button" onclick={() => void composer.selectGroup(variant, g)}>Add group: {g.name}</button>{/each}
    </div>
  {/if}
  {#if variant.channels.length > 1}
    <label>
      Minutes between channels
      <input
        type="number"
        min="0"
        max="1440"
        value={variant.staggerMinutes ?? $settings.defaultStaggerMinutes}
        onchange={(e) => void composer.setStagger(variant, Number(e.currentTarget.value))} />
    </label>
  {/if}
</section>
