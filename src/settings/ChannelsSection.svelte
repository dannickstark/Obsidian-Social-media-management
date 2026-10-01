<script lang="ts">
  import { PLATFORMS, PLATFORM_META } from "../model/platforms";
  import type { Channel, ChannelGroup } from "../model/types";
  import ChannelAvatar from "../ui/ChannelAvatar.svelte";
  import { useOsmm } from "../ui/context";
  import ChannelForm from "./ChannelForm.svelte";
  import GroupForm from "./GroupForm.svelte";
  import { SvelteModal } from "../ui/dialogs";

  const ctx = useOsmm();
  const { app, settings, snapshot, channels, actions } = ctx;
  const METHOD_LABEL: Record<string, string> = { api: "API · auto", native: "API · native schedule", assisted: "Assisted" };

  function credentialSummary(channel: Channel): string {
    if (!channel.secretId) return "no credential";
    switch (channel.platform) {
      case "facebook": return "user token · Page discovery";
      case "instagram": return "credential set · public image host required";
      case "linkedin": return "credential set · exact-token grants required";
      case "x": return "credential set · identity only; write tier unverified";
      default: return "credential set";
    }
  }

  const grouped = $derived(
    PLATFORMS.map((p) => ({ p, list: $settings.channels.filter((c) => c.platform === p) })).filter((g) => g.list.length),
  );

  function editChannel(channel?: Channel): void {
    new SvelteModal(app, channel ? `Edit ${channel.name}` : "Add channel", ChannelForm, { channel }, ctx).open();
  }
  function editGroup(group?: ChannelGroup): void {
    new SvelteModal(app, group ? `Edit ${group.name}` : "Add channel group", GroupForm, { group }, ctx).open();
  }
  async function removeChannel(c: Channel): Promise<void> {
    const used = channels.usage(c.id, $snapshot.variants).length;
    const ok = await actions.confirm(`Remove ${c.name}? It is used by ${used} note${used === 1 ? "" : "s"}; those notes keep the id and will show a warning.`, "Remove");
    if (ok) await channels.removeChannel(c.id);
  }
  async function removeGroup(g: ChannelGroup): Promise<void> {
    if (await actions.confirm(`Remove the group ${g.name}? Channels are kept.`, "Remove")) await channels.removeGroup(g.id);
  }
</script>

<div class="osmm-channels">
  <div class="osmm-row">
    <p class="osmm-progress">A channel is one place you publish: your profile, a page, a group, a server channel or a website.</p>
    <span class="osmm-spacer"></span>
    <button type="button" class="mod-cta" onclick={() => editChannel()}>Add channel</button>
  </div>
  {#each grouped as { p, list } (p)}
    <h4>{PLATFORM_META[p].label}</h4>
    {#each list as c (c.id)}
      <div class="osmm-row setting-item">
        <ChannelAvatar channel={c} />
        <span class="osmm-row-title">{c.name} <span class="osmm-progress">{c.id}</span></span>
        <span class="osmm-pill-status">{METHOD_LABEL[c.method]}</span>
        <span class="osmm-progress">{credentialSummary(c)}</span>
        <button type="button" onclick={() => editChannel(c)}>Edit</button>
        <button type="button" aria-label={`Remove ${c.name}`} onclick={() => void removeChannel(c)}>Remove</button>
      </div>
    {/each}
  {:else}
    <p>No channels yet.</p>
  {/each}

  <div class="osmm-row">
    <h4>Channel groups</h4>
    <span class="osmm-spacer"></span>
    <button type="button" onclick={() => editGroup()}>Add group</button>
  </div>
  {#each $settings.channelGroups as g (g.id)}
    <div class="osmm-row setting-item">
      <span class="osmm-row-title">{g.name} <span class="osmm-progress">{g.channelIds.length} channels</span></span>
      <button type="button" onclick={() => editGroup(g)}>Edit</button>
      <button type="button" aria-label={`Remove group ${g.name}`} onclick={() => void removeGroup(g)}>Remove</button>
    </div>
  {/each}
</div>
