<script lang="ts">
  import { untrack } from "svelte";
  import { PLATFORMS, PLATFORM_META, type Platform } from "../model/platforms";
  import { CHANNEL_KINDS, PUBLISH_METHODS, zChannel, zodIssues } from "../model/schemas";
  import type { Channel, Issue } from "../model/types";
  import { platformDef } from "../platforms/registry";
  import type { TelegramChat } from "../platforms/telegram/api";
  import type { FacebookPageChoice } from "../platforms/facebook/api";
  import { useOsmm } from "../ui/context";
  import { secretField } from "../ui/secretField";
  import { PLATFORM_COLORS } from "../ui/colors";

  let { channel, close }: { channel?: Channel; close: () => void } = $props();
  const { app, channels, publish } = useOsmm();
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
  let server = $state(initial?.server ?? "");
  let login = $state(initial?.login ?? "");
  let postAsName = $state(initial?.postAsName ?? "");
  let postAsAvatar = $state(initial?.postAsAvatar ?? "");
  let issues = $state<Issue[]>([]);
  let testing = $state(false);
  let testResult = $state("");
  let chats = $state<TelegramChat[]>([]);
  let chatNote = $state("");
  let facebookPages = $state<FacebookPageChoice[]>([]);
  let facebookNote = $state("");
  let findingFacebookPages = $state(false);
  let selectedFacebookPageId = $state(initial?.platform === "facebook" && initial.method !== "assisted" ? initial.handle ?? "" : "");
  let selectedFacebookSecretId = $state(initial?.platform === "facebook" && initial.method !== "assisted" ? initial.secretId ?? "" : "");

  $effect(() => {
    if (!idTouched) id = name.trim() ? channels.suggestId(platform, name) : "";
  });

  const KIND_LABEL: Record<string, string> = { profile: "Profile", page: "Page", group: "Group", server_channel: "Server channel", site: "Website", account: "Account" };
  const METHOD_LABEL: Record<string, string> = { api: "API (auto-post)", native: "API with native scheduling", assisted: "Assisted (remind + open)" };
  const HANDLE_LABEL: Partial<Record<Platform, string>> = {
    telegram: "Chat id (@name or -100…)",
    mastodon: "Handle (@you@your.instance)",
    bluesky: "Handle (you.bsky.social)",
    x: "X username (without @)",
    facebook: "Page id",
  };
  const SERVER_LABEL: Partial<Record<Platform, string>> = { mastodon: "Server (optional)", bluesky: "PDS (optional)", wordpress: "Site address (https://…)" };
  const CREDENTIAL_HINT: Partial<Record<Platform, string>> = {
    telegram: "The bot token from @BotFather. The bot must be an admin of the channel that can post messages.",
    discord: "The channel's webhook URL (Server settings → Integrations → Webhooks → Copy Webhook URL).",
    mastodon: "An access token (Preferences → Development → New application, scopes read and write).",
    bluesky: "An app password (Settings → Privacy and security → App passwords), not your account password.",
    x: "OAuth 2 user access token with tweet.write and media.write. OAuth app approval and API tier access are not verified by this plugin.",
    wordpress: "An application password (Users → Profile → Application passwords).",
    facebook: "A user access token with pages_show_list, pages_read_engagement and pages_manage_posts. Page access tokens stay in memory and are never saved to settings.",
  };

  const def = $derived(platformDef(platform));
  const facebookReady = $derived(platform !== "facebook" || (!!secretId && !!app.secretStorage.getSecret(secretId) && kind === "page" && /^\d+$/.test(handle) && handle === selectedFacebookPageId && secretId === selectedFacebookSecretId));
  const methods = $derived(PUBLISH_METHODS.filter((m) => {
    if (m === "assisted") return true;
    // No public media host is configured by the plugin yet; keep Instagram on the assisted path.
    if (platform === "instagram" && m === "api") return false;
    if (platform === "facebook" && !facebookReady) return false;
    return (m === "api" && def.capabilities.api) || (m === "native" && def.capabilities.nativeSchedule);
  }));
  $effect(() => {
    if (!methods.includes(method)) method = "assisted";
  });

  function input(): Record<string, unknown> {
    return {
      id: editing ? initial!.id : id,
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
      server: SERVER_LABEL[platform] && server.trim() ? server.trim() : undefined,
      login: platform === "wordpress" && login.trim() ? login.trim() : undefined,
      postAsName: platform === "discord" && postAsName.trim() ? postAsName.trim() : undefined,
      postAsAvatar: platform === "discord" && postAsAvatar.trim() ? postAsAvatar.trim() : undefined,
    };
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const parsed = zChannel.safeParse(input());
    if (!parsed.success) {
      issues = zodIssues(parsed.error);
      return;
    }
    if (platform === "facebook" && method !== "assisted") {
      const answer = await publish.verifyChannel(parsed.data);
      if (!answer.ok) {
        method = "assisted";
        facebookNote = `${answer.error} Assisted publishing remains available.`;
      }
    }
    // Editing never renames (that would orphan notes using the old id); adding never overwrites.
    const result = editing ? await channels.upsertChannel(input()) : await channels.createChannel(input());
    if (!result.ok) {
      issues = result.issues;
      return;
    }
    close();
  }

  async function testConnection(): Promise<void> {
    testResult = "";
    const parsed = zChannel.safeParse(input());
    if (!parsed.success) {
      issues = zodIssues(parsed.error);
      return;
    }
    issues = [];
    testing = true;
    const answer = await publish.verifyChannel(parsed.data);
    testing = false;
    testResult = answer.ok ? `Connected: ${answer.account}` : answer.error;
  }

  async function findChats(): Promise<void> {
    chats = [];
    chatNote = "";
    const found = await publish.findTelegramChats(secretId);
    if ("error" in found) chatNote = found.error;
    else if (!found.length) chatNote = "No channels yet. Add the bot to the channel as an admin, post something there, then try again.";
    else chats = found;
  }

  function useChat(c: TelegramChat): void {
    handle = c.username ? `@${c.username}` : c.id;
    chats = [];
  }

  function changeSecret(id: string): void {
    if (platform === "facebook" && id !== secretId) {
      facebookPages = [];
      facebookNote = "";
      selectedFacebookPageId = "";
      selectedFacebookSecretId = "";
      handle = "";
      method = "assisted";
    }
    secretId = id;
  }

  async function findFacebookPages(): Promise<void> {
    facebookPages = [];
    facebookNote = "";
    findingFacebookPages = true;
    const found = await publish.findFacebookPages(secretId);
    findingFacebookPages = false;
    if ("error" in found) {
      facebookNote = found.error;
      selectedFacebookPageId = "";
      selectedFacebookSecretId = "";
      method = "assisted";
    }
    else if (!found.length) facebookNote = "No Pages were found for this token. Check the token and Page access, or use assisted publishing.";
    else facebookPages = found;
  }

  function useFacebookPage(page: FacebookPageChoice): void {
    handle = page.id;
    kind = "page";
    selectedFacebookPageId = page.canPublish ? page.id : "";
    selectedFacebookSecretId = page.canPublish ? secretId : "";
    if (!page.canPublish) method = "assisted";
    facebookNote = page.canPublish ? "Page access and publishing permissions verified." : "This Page is missing publishing permissions. Assisted publishing remains available.";
    facebookPages = [];
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
  <label>{HANDLE_LABEL[platform] ?? "Handle / URL"}<input type="text" bind:value={handle} /></label>
  {#if platform === "telegram"}
    <div class="osmm-row">
      <button type="button" disabled={!secretId} onclick={() => void findChats()}>Find chat id</button>
      {#if chatNote}<span class="osmm-progress" role="status">{chatNote}</span>{/if}
    </div>
    {#if chats.length}
      <div class="osmm-chips" role="group" aria-label="Channels the bot can see">
        {#each chats as c (c.id)}
          <button type="button" onclick={() => useChat(c)}>Use {c.title}{c.username ? ` (@${c.username})` : ""}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if platform === "facebook"}
    <p class="osmm-progress">OAuth app review is unverified. Add a user access token to discover Pages; profiles and groups use assisted publishing.</p>
    <div class="osmm-row">
      <button type="button" disabled={!secretId || findingFacebookPages} onclick={() => void findFacebookPages()}>Find Facebook Pages</button>
      {#if facebookNote}<span class="osmm-progress" role="status">{facebookNote}</span>{/if}
    </div>
    {#if facebookPages.length}
      <div class="osmm-chips" role="group" aria-label="Facebook Pages the token can see">
        {#each facebookPages as page (page.id)}
          <button type="button" onclick={() => useFacebookPage(page)}>Use {page.name}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if platform === "instagram"}
    <p class="osmm-progress" role="status">Instagram API publishing is unavailable until a secure public image host that Meta can fetch is configured. Use assisted publishing to add images in Instagram.</p>
  {/if}
  {#if platform === "x"}
    <p class="osmm-progress" role="status">X API publishing depends on your app's current API tier. If access is denied, this channel remains available in assisted mode.</p>
  {/if}
  {#if SERVER_LABEL[platform]}
    <label>{SERVER_LABEL[platform]}<input type="url" placeholder="https://" bind:value={server} /></label>
  {/if}
  {#if platform === "wordpress"}
    <label>User name<input type="text" autocomplete="off" bind:value={login} /></label>
  {/if}
  {#if platform === "discord"}
    <label>Post as name (optional)<input type="text" bind:value={postAsName} /></label>
    <label>Post as avatar URL (optional)<input type="url" placeholder="https://" bind:value={postAsAvatar} /></label>
  {/if}
  {#if platform === "mastodon"}
    <label>Character limit<input type="number" min="1" max="100000" placeholder="500" bind:value={maxChars} /></label>
  {/if}
  <label>
    Publishing
    <select bind:value={method}>{#each methods as m (m)}<option value={m}>{METHOD_LABEL[m]}</option>{/each}</select>
  </label>
  <label>Colour<input type="color" bind:value={avatarColor} /></label>
  <label>Default time<input type="time" bind:value={defaultTime} /></label>
  <div>
    <span>Credential (stored only on this device)</span>
    {#if CREDENTIAL_HINT[platform]}<p class="osmm-progress">{CREDENTIAL_HINT[platform]}</p>{/if}
    <div use:secretField={{ app, value: secretId, onchange: changeSecret }}></div>
  </div>
  {#if publish.canVerify(platform)}
    <div class="osmm-row">
      <button type="button" disabled={testing} onclick={() => void testConnection()}>Test connection</button>
      {#if testResult}<span class="osmm-progress" role="status">{testResult}</span>{/if}
    </div>
  {/if}
  {#if issues.length}
    <ul class="osmm-issues" role="alert">{#each issues as i (i.field + i.message)}<li>{i.field}: {i.message}</li>{/each}</ul>
  {/if}
  <div class="modal-button-container">
    <button type="submit" class="mod-cta">Save channel</button>
    <button type="button" onclick={close}>Cancel</button>
  </div>
</form>
