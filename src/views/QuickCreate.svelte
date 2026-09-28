<script module lang="ts">
  import type { Platform } from "../model/platforms";

  export type QuickCreateInput =
    | { kind: "campaign"; title: string }
    | { kind: "post"; title: string; platform: Platform; channels: string[] };

  export function validateQuickCreate(input: QuickCreateInput): string[] {
    const errors: string[] = [];
    if (!input.title.trim()) errors.push(input.kind === "campaign" ? "Give the campaign a title." : "Give the post a title.");
    if (input.kind === "post" && input.channels.length === 0) errors.push("Pick at least one channel.");
    return errors;
  }
</script>

<script lang="ts">
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import { useOsmm } from "../ui/context";

  let { kind, close }: { kind: "campaign" | "post"; close: () => void } = $props();
  const { channels, snapshot, actions } = useOsmm();

  let title = $state("");
  let date = $state("");
  let time = $state("18:00");
  let link = $state("");
  let platform = $state<Platform>("linkedin");
  let selected = $state<string[]>([]);
  let campaignPath = $state("");
  let errors = $state<string[]>([]);

  const platformChannels = $derived(channels.byPlatform(platform));

  function when(): number | undefined {
    if (!date) return undefined;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const [h, min] = (time || "09:00").split(":").map(Number) as [number, number];
    return new Date(y, m - 1, d, h, min).getTime();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const input: QuickCreateInput =
      kind === "campaign" ? { kind: "campaign", title } : { kind: "post", title, platform, channels: selected };
    errors = validateQuickCreate(input);
    if (errors.length) return;
    if (kind === "campaign") await actions.createCampaign({ title, anchorDate: when(), link: link || undefined });
    else await actions.createPost({ title, platform, channels: selected, scheduledAt: when(), campaignPath: campaignPath || undefined });
    close();
  }
</script>

<form class="osmm-form" onsubmit={submit}>
  <label>Title<input type="text" bind:value={title} /></label>
  {#if kind === "post"}
    <label>
      Platform
      <select bind:value={platform} onchange={() => (selected = [])}>
        {#each PLATFORMS as p (p)}<option value={p}>{PLATFORM_META[p].label}</option>{/each}
      </select>
    </label>
    <fieldset>
      <legend>Channels</legend>
      {#each platformChannels as c (c.id)}
        <label class="osmm-row"><input type="checkbox" value={c.id} bind:group={selected} />{c.name}</label>
      {:else}
        <p class="osmm-progress">No {PLATFORM_META[platform].label} channels yet. Add one in settings.</p>
      {/each}
    </fieldset>
    <label>
      Campaign
      <select bind:value={campaignPath}>
        <option value="">Standalone post</option>
        {#each $snapshot.campaigns as c (c.path)}<option value={c.path}>{c.title}</option>{/each}
      </select>
    </label>
  {/if}
  <label>{kind === "campaign" ? "Anchor date" : "Date"}<input type="date" bind:value={date} /></label>
  <label>Time<input type="time" bind:value={time} /></label>
  {#if kind === "campaign"}<label>Link<input type="url" bind:value={link} placeholder="https://" /></label>{/if}
  {#if errors.length}
    <ul class="osmm-issues" role="alert">{#each errors as e (e)}<li>{e}</li>{/each}</ul>
  {/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">{kind === "campaign" ? "Create campaign" : "Create post"}</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
