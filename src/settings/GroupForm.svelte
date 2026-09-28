<script lang="ts">
  import { untrack } from "svelte";
  import { PLATFORM_META } from "../model/platforms";
  import type { ChannelGroup, Issue } from "../model/types";
  import { useOsmm } from "../ui/context";

  let { group, close }: { group?: ChannelGroup; close: () => void } = $props();
  const { channels } = useOsmm();
  /** Snapshot the prop once: this form only ever initializes from it, never reacts to later changes. */
  const initial = untrack(() => group);
  let name = $state(initial?.name ?? "");
  let selected = $state<string[]>(initial ? [...initial.channelIds] : []);
  let issues = $state<Issue[]>([]);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await channels.upsertGroup({ id: initial?.id ?? slug(name), name, channelIds: selected });
    if (!result.ok) issues = result.issues;
    else close();
  }
</script>

<form class="osmm-form" onsubmit={save}>
  <label>Group name<input type="text" bind:value={name} /></label>
  <fieldset>
    <legend>Channels</legend>
    {#each channels.list() as c (c.id)}
      <label class="osmm-row"><input type="checkbox" value={c.id} bind:group={selected} />{PLATFORM_META[c.platform].label} · {c.name}</label>
    {/each}
  </fieldset>
  {#if issues.length}<ul class="osmm-issues" role="alert">{#each issues as i (i.message)}<li>{i.message}</li>{/each}</ul>{/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">Save group</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
