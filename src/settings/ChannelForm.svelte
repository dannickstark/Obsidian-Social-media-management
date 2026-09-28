<script lang="ts">
  import { untrack } from "svelte";
  import { PLATFORMS, PLATFORM_META, type Platform } from "../model/platforms";
  import { CHANNEL_KINDS, PUBLISH_METHODS } from "../model/schemas";
  import type { Channel, Issue } from "../model/types";
  import { useOsmm } from "../ui/context";
  import { secretField } from "../ui/secretField";
  import { PLATFORM_COLORS } from "../ui/colors";

  let { channel, close }: { channel?: Channel; close: () => void } = $props();
  const { app, channels } = useOsmm();
  /** Snapshot the prop once: this form only ever initializes from it, never reacts to later changes. */
  const initial = untrack(() => channel);
  const editing = !!initial;

  let platform = $state<Platform>(initial?.platform ?? "linkedin");
  let name = $state(initial?.name ?? "");
  let id = $state(initial?.id ?? "");
  let idTouched = $state(editing);
  let kind = $state(initial?.kind ?? "profile");
  let handle = $state(initial?.handle ?? "");
  let method = $state(initial?.method ?? "assisted");
  let avatarColor = $state(initial?.avatarColor ?? PLATFORM_COLORS.linkedin);
  let defaultTime = $state(initial?.defaultTime ?? "");
  let secretId = $state(initial?.secretId ?? "");
  let maxChars = $state<number | null | undefined>(initial?.maxChars);
  let issues = $state<Issue[]>([]);

  $effect(() => {
    if (!idTouched) id = name.trim() ? channels.suggestId(platform, name) : "";
  });

  const KIND_LABEL: Record<string, string> = { profile: "Profile", page: "Page", group: "Group", server_channel: "Server channel", site: "Website", account: "Account" };
  const METHOD_LABEL: Record<string, string> = { api: "API (auto-post)", native: "API with native scheduling", assisted: "Assisted (remind + open)" };

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const input = {
      id,
      platform,
      name,
      kind,
      handle: handle || undefined,
      method,
      avatarColor,
      defaultTime: defaultTime || undefined,
      secretId: secretId || undefined,
      defaultReminders: initial?.defaultReminders,
      maxChars: platform === "mastodon" && maxChars ? maxChars : undefined,
    };
    // Editing never renames (that would orphan notes using the old id); adding never overwrites.
    const result = editing ? await channels.upsertChannel({ ...input, id: initial!.id }) : await channels.createChannel(input);
    if (!result.ok) {
      issues = result.issues;
      return;
    }
    close();
  }
</script>

<form class="osmm-form" onsubmit={save}>
  <label>
    Platform
    <select bind:value={platform} disabled={editing} onchange={() => (avatarColor = PLATFORM_COLORS[platform])}>
      {#each PLATFORMS as p (p)}<option value={p}>{PLATFORM_META[p].label}</option>{/each}
    </select>
  </label>
  <label>Name<input type="text" bind:value={name} /></label>
  <label>Channel id<input type="text" bind:value={id} readonly={editing} oninput={() => (idTouched = true)} /></label>
  <label>
    Kind
    <select bind:value={kind}>{#each CHANNEL_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}</select>
  </label>
  <label>Handle / URL<input type="text" bind:value={handle} /></label>
  {#if platform === "mastodon"}
    <label>Character limit<input type="number" min="1" max="100000" placeholder="500" bind:value={maxChars} /></label>
  {/if}
  <label>
    Publishing
    <select bind:value={method}>{#each PUBLISH_METHODS as m (m)}<option value={m}>{METHOD_LABEL[m]}</option>{/each}</select>
  </label>
  <label>Colour<input type="color" bind:value={avatarColor} /></label>
  <label>Default time<input type="time" bind:value={defaultTime} /></label>
  <div>
    <span>Credential (stored only on this device)</span>
    <div use:secretField={{ app, value: secretId, onchange: (v) => (secretId = v) }}></div>
  </div>
  {#if issues.length}
    <ul class="osmm-issues" role="alert">{#each issues as i (i.field + i.message)}<li>{i.field}: {i.message}</li>{/each}</ul>
  {/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">Save channel</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
