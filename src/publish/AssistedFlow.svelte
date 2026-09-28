<script lang="ts">
  import { untrack } from "svelte";
  import type { LoadedContent } from "../composer/content";
  import { PLATFORM_META } from "../model/platforms";
  import type { ClipItem } from "../platforms/types";
  import Preview from "../previews/Preview.svelte";
  import { useOsmm } from "../ui/context";
  import { isMobile } from "./clipboard";

  let { path, channelIds, startStep = 1, close }: { path: string; channelIds: string[]; startStep?: 1 | 3; close: () => void } = $props();
  const { snapshot, channels, composer, publish } = useOsmm();

  let pos = $state(0);
  let step = $state<1 | 2 | 3>(untrack(() => startStep));
  let content = $state<LoadedContent | null>(null);
  let copied = $state<string[]>([]);
  let liveUrl = $state("");
  let reason = $state("");
  let error = $state("");

  const variant = $derived($snapshot.variants.find((v) => v.path === path));
  const channelId = $derived(channelIds[pos]);
  const channel = $derived(channelId ? channels.get(channelId) : undefined);
  const label = $derived(variant ? PLATFORM_META[variant.platform].label : "");

  let loadedFor = "";
  $effect(() => {
    const v = variant;
    if (!v || loadedFor === v.path) return;
    loadedFor = v.path;
    void composer.content.load(v).then((c) => (content = c));
  });

  const target = $derived(variant && channel && content ? publish.target(variant, channel, content) : null);
  const model = $derived(variant && content ? composer.preview(variant, content, channel) : null);
  const blocking = $derived(variant && content ? composer.check(variant, content).filter((i) => i.level === "error") : []);
  const opens = $derived(!!target && (!!target.url || (isMobile() && !!target.mobileUrl)));

  function nextChannel(): void {
    liveUrl = "";
    reason = "";
    error = "";
    copied = [];
    if (pos + 1 < channelIds.length) {
      pos += 1;
      step = 1;
    } else close();
  }

  async function open(): Promise<void> {
    if (!target || !channelId) return;
    const result = await publish.openTarget(path, channelId, target);
    const first = target.clipboard[0];
    if (first && result && result !== "failed") copied = [first.label];
  }

  async function copy(item: ClipItem): Promise<void> {
    if ((await publish.copyItem(item)) !== "failed") copied = [...copied, item.label];
  }

  async function mark(withLink: boolean): Promise<void> {
    if (!channelId) return;
    const result = await publish.markPublished(path, channelId, withLink ? liveUrl : "");
    if (result.ok) nextChannel();
    else error = result.reason;
  }

  async function skipChannel(): Promise<void> {
    if (channelId && (await publish.skip(path, channelId, reason))) nextChannel();
  }
</script>

<div class="osmm-assisted">
  <p class="osmm-progress">{label} · {channel?.name ?? channelId} ({pos + 1} of {channelIds.length})</p>
  <ol class="osmm-steps" aria-label="Steps">
    <li aria-current={step === 1 ? "step" : undefined}>Check</li>
    <li aria-current={step === 2 ? "step" : undefined}>Open and paste</li>
    <li aria-current={step === 3 ? "step" : undefined}>Confirm</li>
  </ol>

  {#if step === 1}
    {#if model}<Preview {model} />{:else}<p class="osmm-progress">Loading…</p>{/if}
    {#if blocking.length}
      <ul class="osmm-issue-list" role="alert">
        {#each blocking as issue, i (i)}<li class="is-error">{issue.message}</li>{/each}
      </ul>
    {/if}
    <div class="modal-button-container">
      <button type="button" class="mod-cta" disabled={!model} onclick={() => (step = 2)}>Next</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {:else if step === 2 && target}
    <p>{target.hint}</p>
    <div class="modal-button-container">
      <button type="button" class="mod-cta" onclick={() => void open()}>{opens ? `Open ${label}` : "Copy the text"}</button>
    </div>
    {#if target.clipboard.length > 1}
      <ul class="osmm-clip-list">
        {#each target.clipboard.slice(1) as item (item.label)}
          <li><button type="button" onclick={() => void copy(item)}>Copy {item.label.toLowerCase()}</button></li>
        {/each}
      </ul>
    {/if}
    {#if copied.length}<p class="osmm-progress" role="status">Copied: {copied.join(", ")}</p>{/if}
    <div class="modal-button-container">
      <button type="button" onclick={() => (step = 3)}>I've posted it</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {:else if step === 3}
    <label>Link to the live post<input type="url" placeholder="https://" bind:value={liveUrl} /></label>
    {#if error}<p class="osmm-issues" role="alert">{error}</p>{/if}
    <div class="modal-button-container">
      <button type="button" class="mod-cta" disabled={!liveUrl.trim()} onclick={() => void mark(true)}>Mark published</button>
      <button type="button" onclick={() => void mark(false)}>Published, no link</button>
    </div>
    <label>Reason (optional)<input type="text" bind:value={reason} /></label>
    <div class="modal-button-container">
      <button type="button" class="mod-warning" onclick={() => void skipChannel()}>Skip this channel</button>
      <button type="button" onclick={close}>Close</button>
    </div>
  {/if}
</div>
