import { Notice, Platform, Plugin } from "obsidian";
import { writable, type Writable } from "svelte/store";
import "./styles/index.css";
import { ChannelRegistry } from "./channels/registry";
import { createVoiceProfile } from "./claude/voice";
import { registerCommands } from "./commands";
import { ComposerActions } from "./composer/actions";
import { ComposerView } from "./composer/ComposerView";
import { HELD_REFUSAL, heldForReview, overdueRows } from "./index/queries";
import { indexStore } from "./index/stores";
import { SocialIndex } from "./index/socialIndex";
import { ApprovalGate } from "./mcp/approval";
import { openApprovalModal } from "./mcp/ApprovalModal";
import { registerAllTools } from "./mcp/index";
import { McpDispatcher } from "./mcp/protocol";
import { McpService } from "./mcp/service";
import { ToolRegistry } from "./mcp/tools";
import { IMAGE_MIME } from "./media/mediaInfo";
import { NoteFactory } from "./model/factory";
import { SafeWriter } from "./model/writer";
import { createAdapters, type AdapterDeps } from "./platforms/adapters";
import { obsidianHttp } from "./platforms/http";
import { LinkCardFetcher } from "./platforms/og";
import { AdapterRegistry } from "./platforms/registry";
import { viewStateStore } from "./planner/viewState";
import { PublishActions } from "./publish/actions";
import { assistedQueue } from "./publish/assistedFlow";
import { effectiveDelivery } from "./publish/eligibility";
import { ClipboardService } from "./publish/clipboard";
import { VaultLog } from "./publish/vaultLog";
import { PreviewGridView } from "./previews/PreviewGridView";
import { NotifiedLedger } from "./reminders/ledger";
import { PhoneAlerts } from "./reminders/ntfy/alerts";
import { NtfyBooker } from "./reminders/ntfy/booker";
import { BookingLedger } from "./reminders/ntfy/bookings";
import { NtfyClient } from "./reminders/ntfy/client";
import { ntfyTarget } from "./reminders/ntfy/config";
import { POST_ACTION, reminderMessage, type ReminderContentDeps } from "./reminders/ntfy/content";
import { Notifier } from "./reminders/notifier";
import { ReminderService } from "./reminders/service";
import { Scheduler } from "./scheduler/scheduler";
import { allSecretIds, Secrets } from "./secrets/secrets";
import { loadDeviceSettings, saveDeviceSettings, type DeviceSettings } from "./settings/device";
import { PublisherService } from "./settings/publisher";
import { autoPostLateMs, migrateSettings, type OsmmSettings } from "./settings/settings";
import { OsmmSettingTab } from "./settings/tab";
import {
  PlannerActions,
  VIEW_COMPOSER,
  VIEW_PLANNER,
  VIEW_PREVIEW_GRID,
  VIEW_SIDEBAR,
} from "./ui/actions";
import { clock, type OsmmContext } from "./ui/context";
import { SvelteRenderChild } from "./ui/SvelteView";
import { activateView, PlannerView } from "./views/PlannerView";
import { SidebarView } from "./views/SidebarView";
import CampaignTable from "./views/CampaignTable.svelte";
import { withTimeout } from "./util/time";

/** How long a phone link waits for a cold start (index built, startup check done) before giving up. */
export const LINK_READY_TIMEOUT_MS = 30_000;

export default class OsmmPlugin extends Plugin {
  override settings!: OsmmSettings;
  settingsStore!: Writable<OsmmSettings>;
  device!: DeviceSettings;
  publisher!: PublisherService;
  secrets!: Secrets;
  writer!: SafeWriter;
  factory!: NoteFactory;
  channels!: ChannelRegistry;
  index!: SocialIndex;
  scheduler!: Scheduler;
  reminders!: ReminderService;
  private desktopNotifier!: Notifier;
  /** The desktop notifier (M3 P6); `publish.notifier` is a fan-out to it and to the phone alerts. */
  get notifier(): Notifier {
    return this.desktopNotifier;
  }
  ntfy!: NtfyClient;
  phone!: NtfyBooker;
  readonly adapters = new AdapterRegistry();
  /** OpenGraph link cards for the previews and Bluesky's external embed (#93). */
  linkCards!: LinkCardFetcher;
  log!: VaultLog;
  /** MCP tools for Claude Code (spec §6.1); the server exposes them only on a desktop, when switched on. */
  tools!: ToolRegistry;
  /** Asks the user in Obsidian before Claude publishes (#77). */
  approvals!: ApprovalGate;
  mcp!: McpService;
  private unloaded = false;
  /** Set once the startup reconcile has run; later role changes run their own (M3 P2). */
  private started = false;
  /** Counts publisher-role changes, so start-up can tell whether its reconcile finished as the publisher. */
  private roleChanges = 0;
  private markReady: () => void = () => undefined;
  /** Resolves once the index is built and the scheduler runs; phone links wait for it (cold start). */
  readonly ready: Promise<void> = new Promise((resolve) => (this.markReady = resolve));
  private ui: OsmmContext | undefined;
  /** Pending orchestrator retry delays, cleared on unload so no retry fires after the plugin is gone. */
  private readonly delays = new Set<number>();

  override async onload(): Promise<void> {
    this.register(() => {
      this.unloaded = true;
      for (const handle of this.delays) window.clearTimeout(handle);
      this.delays.clear();
    });
    try {
      this.settings = migrateSettings(await this.loadData());
    } catch (error) {
      // e.g. settings saved by a newer schema: tell the user and stay inert rather than overwrite them.
      new Notice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.settingsStore = writable(this.settings);
    this.device = loadDeviceSettings(this.app);
    this.publisher = new PublisherService({
      device: () => this.device,
      settings: () => this.settings,
      update: (patch) => this.updateSettings(patch),
      now: () => Date.now(),
      // Final review 3: phone reminders are booked by the publisher only, and set up per device.
      claimed: () => {
        if (!this.device.ntfy.enabled) new Notice("Phone reminders are off on this device — set them up under Phone reminders (ntfy).");
      },
    });
    this.secrets = new Secrets(this.app);
    this.linkCards = new LinkCardFetcher({ http: obsidianHttp, now: () => Date.now() });
    // M5: the API adapters (spec §4.2). Registered on every device; only the publisher dispatches through them.
    for (const adapter of createAdapters(this.adapterDeps())) this.adapters.register(adapter);
    this.writer = new SafeWriter(this.app);
    this.factory = new NoteFactory(this.app, this.writer, {
      rootFolder: () => this.settings.rootFolder,
      defaultStaggerMinutes: () => this.settings.defaultStaggerMinutes,
    });
    this.channels = new ChannelRegistry({
      read: () => this.settings,
      write: async (next) => {
        // Task 9 carry: a channel removed here must not stay listed in publishWithoutAsking.
        const ids = new Set(next.channels.map((c) => c.id));
        const publishWithoutAsking = this.settings.publishWithoutAsking.filter((id) => ids.has(id));
        this.settings = migrateSettings({ ...this.settings, ...next, publishWithoutAsking });
        this.settingsStore.set(this.settings);
        await this.saveSettings();
      },
    });
    this.log = new VaultLog({
      app: this.app,
      rootFolder: () => this.settings.rootFolder,
      redact: (text) => this.secrets.redact(text, allSecretIds(this.channels.list())),
      channelName: (id) => this.channels.get(id)?.name ?? id,
      warn: (message) => new Notice(message, 0),
    });
    this.index = new SocialIndex(this.app);
    this.register(() => this.index.stop());
    // Rebook soon after an edit (reschedule, skip, publish early) instead of waiting for the next tick.
    let pendingSync: number | null = null;
    this.register(
      this.index.onChange(() => {
        if (pendingSync !== null) window.clearTimeout(pendingSync);
        pendingSync = window.setTimeout(() => {
          pendingSync = null;
          void this.phone.sync();
        }, 5_000);
      }),
    );
    this.register(() => {
      if (pendingSync !== null) window.clearTimeout(pendingSync);
    });

    const ui = this.uiContext();
    const notifier = (this.desktopNotifier = new Notifier({
      ledger: new NotifiedLedger(this.app, () => Date.now()),
      enabled: () => this.device.notifications,
      channelName: (id) => this.channels.get(id)?.name ?? id,
      noteTitle: (path) => this.index.getVariant(path)?.displayTitle ?? path,
      openAssisted: (path, ids) => void ui.publish.openAssisted(path, ids),
      openComposer: (path) => void ui.composer.openComposer(path),
    }));
    this.register(() => notifier.dispose());
    this.reminders = new ReminderService({
      rows: () => ui.actions.rows(),
      channels: this.channels,
      adapters: this.adapters,
      settings: () => this.settings,
      notifier,
    });
    this.ntfy = new NtfyClient(() => ntfyTarget(this.device, this.secrets));
    const phoneContent: ReminderContentDeps = {
      vaultName: () => this.app.vault.getName(),
      variant: (path) => this.index.getVariant(path),
      channelName: (id) => this.channels.get(id)?.name ?? id,
      targetUrl: async (path, channelId) => {
        const v = this.index.getVariant(path);
        const channel = this.channels.get(channelId);
        if (!v || !channel) return null;
        const target = ui.publish.target(v, channel, await ui.composer.content.load(v));
        return target.mobileUrl ?? target.url;
      },
      // Task 8 ruling: once the server can't cancel, a push can't follow edits, so it links through Obsidian.
      cancelSupported: (path) => this.phone.cancelSupported(path),
    };
    this.phone = new NtfyBooker({
      rows: () => ui.actions.rows(),
      offsets: (row) => this.reminders.offsets(row),
      isPublisher: () => this.publisher.isPublisher(),
      enabled: () => this.device.ntfy.enabled,
      client: this.ntfy,
      ledger: new BookingLedger(this.app),
      compose: async (item) => {
        const target = ntfyTarget(this.device, this.secrets);
        if (!target) throw new Error("Phone reminders aren't set up.");
        return reminderMessage(item, phoneContent, target);
      },
      now: () => Date.now(),
      warn: (message) => new Notice(message, 0),
    });
    this.register(() => this.phone.stop());
    const alerts = new PhoneAlerts({
      enabled: () => this.device.ntfy.enabled && this.device.ntfy.results,
      isPublisher: () => this.publisher.isPublisher(),
      client: this.ntfy,
      content: phoneContent,
      warn: (message) => new Notice(message),
    });
    this.register(() => alerts.stop());
    ui.publish.notifier = {
      due: (path, channelId) => notifier.due(path, channelId),
      failed: (info) => {
        notifier.failed(info);
        alerts.failed(info);
      },
      published: (info) => alerts.published(info),
    };
    this.scheduler = new Scheduler({
      index: this.index,
      settings: () => this.settings,
      now: () => Date.now(),
      isPublisher: () => this.publisher.isPublisher(),
      autoPostLateMs: () => autoPostLateMs(this.settings),
      publish: ui.publish,
      onTick: (now, previous) =>
        Promise.resolve()
          .then(async () => {
            await this.reminders.tick(now, previous);
          })
          .catch((e) => void new Notice(e instanceof Error ? e.message : String(e), 0))
          // Phone bookings run on every tick; the booker itself checks the publisher role and the setting
          // (spec §4.3–4.4). Not awaited (M3 P5): a slow ntfy server must never hold back due posts.
          .then(() => void this.phone.sync()),
      warn: (message) => new Notice(message, 0),
    });
    this.register(() => this.scheduler.stop());
    this.tools = new ToolRegistry({
      redact: (text) => this.secrets.redact(text, allSecretIds(this.channels.list())),
      onCall: (name, ok) => this.mcp.record(ok ? name : `${name} (refused)`),
    });
    this.approvals = new ApprovalGate({
      open: (req, answer) => openApprovalModal(this.app, req, answer),
      allowedWithoutAsking: (id) => this.settings.publishWithoutAsking.includes(id),
    });
    this.register(() => this.approvals.dispose());
    registerAllTools(this.tools, {
      app: this.app,
      index: this.index,
      channels: this.channels,
      factory: this.factory,
      writer: this.writer,
      planner: ui.actions,
      composer: ui.composer,
      publish: ui.publish,
      secrets: this.secrets,
      settings: () => this.settings,
      now: () => Date.now(),
      isPublisher: () => this.publisher.isPublisher(),
      approvals: this.approvals,
    });
    const dispatcher = new McpDispatcher({ tools: this.tools, version: this.manifest.version });
    this.mcp = new McpService({
      desktop: () => Platform.isDesktopApp,
      settings: () => this.device.mcp,
      secrets: this.secrets,
      handle: (message) => dispatcher.handle(message),
      version: this.manifest.version,
      now: () => Date.now(),
    });
    ui.mcp = this.mcp;
    this.register(() => void this.mcp.dispose());
    // A device that becomes the publisher after start-up runs the startup check it skipped (spec §5.1, M3 P2).
    let wasPublisher = this.publisher.isPublisher();
    this.register(
      this.settingsStore.subscribe(() => {
        const now = this.publisher.isPublisher();
        if (now !== wasPublisher) this.roleChanges++;
        // The booker follows the role: a device that lost it cancels its phone bookings now, not at the next tick.
        if (!now && wasPublisher && !this.unloaded) void this.phone.sync();
        if (now && !wasPublisher && this.started && !this.unloaded) {
          void this.scheduler
            .becamePublisher()
            .then(async () => {
              if (!this.unloaded) await this.scheduler.tick();
            })
            .catch((e) => void new Notice(e instanceof Error ? e.message : String(e), 0));
        }
        wasPublisher = now;
      }),
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.scheduler.tick();
    });

    this.addSettingTab(new OsmmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      this.index.start();
      await this.index.build();
      if (this.unloaded) return;
      try {
        const startedAsPublisher = this.publisher.isPublisher();
        const changes = this.roleChanges;
        await this.scheduler.reconcile();
        if (this.unloaded) return;
        this.started = true;
        // It finished as the publisher only if it held the role throughout. Otherwise (the role arrived, or was
        // lost and regained, while it ran) run it again now as the publisher, before the loop starts.
        const finishedAsPublisher = startedAsPublisher && this.roleChanges === changes;
        if (this.publisher.isPublisher() && !finishedAsPublisher) await this.scheduler.becamePublisher();
      } catch (e) {
        // A broken startup check must not leave the planner without its loop, banner and reminders.
        new Notice(e instanceof Error ? e.message : String(e), 0);
        this.started = true;
      }
      if (this.unloaded) return;
      ui.publish.overdueBanner(overdueRows(ui.actions.rows(), Date.now()).length);
      const held = this.index.variants().filter((v) => heldForReview(v)).length;
      if (held) {
        const message = `${held} post${held === 1 ? "" : "s"} written by Claude need${held === 1 ? "s" : ""} your review.`;
        ui.actions.actionNotice(message, "Review", () => activateView(this.app, VIEW_SIDEBAR, "right"));
      }
      if (this.publisher.state().kind === "none") {
        ui.actions.actionNotice("No device publishes scheduled posts yet.", "Publish from this device", () => this.publisher.claim());
      }
      this.scheduler.start();
      this.markReady();
      // After the startup check, so tools see the built index and the settled publisher role.
      void this.mcp.apply();
      void this.scheduler.tick();
    });

    this.registerView(VIEW_PLANNER, (leaf) => new PlannerView(leaf, this.uiContext()));
    this.registerHoverLinkSource(VIEW_PLANNER, { display: "Social planner", defaultMod: true });
    this.registerView(VIEW_SIDEBAR, (leaf) => new SidebarView(leaf, this.uiContext()));
    this.registerView(VIEW_PREVIEW_GRID, (leaf) => new PreviewGridView(leaf, this.uiContext()));
    this.registerView(VIEW_COMPOSER, (leaf) => new ComposerView(leaf, this.uiContext()));

    registerCommands(this);
    this.registerObsidianProtocolHandler(POST_ACTION, (params) =>
      this.openFromLink(params).catch((e: unknown) => void new Notice(`Couldn't open the post from the phone link: ${e instanceof Error ? e.message : String(e)}`)),
    );

    this.registerMarkdownCodeBlockProcessor("social-variants", (_source, el, ctx) => {
      ctx.addChild(
        new SvelteRenderChild(
          el,
          CampaignTable,
          { campaignPath: ctx.sourcePath },
          this.uiContext(),
        ),
      );
    });
  }

  /** Called by Obsidian when data.json was changed on disk, e.g. synced from another device. */
  override async onExternalSettingsChange(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.settingsStore?.set(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async updateSettings(patch: Partial<Omit<OsmmSettings, "schemaVersion">>): Promise<void> {
    this.settings = migrateSettings({ ...this.settings, ...patch });
    this.settingsStore.set(this.settings);
    await this.saveSettings();
  }

  setDevice(patch: Partial<Omit<DeviceSettings, "deviceId">>): void {
    this.device = { ...this.device, ...patch };
    saveDeviceSettings(this.app, this.device);
  }

  private adapterDeps(): AdapterDeps {
    return {
      http: obsidianHttp,
      now: () => Date.now(),
      readBinary: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error(`${path} is not in the vault.`);
        return this.app.vault.readBinary(file);
      },
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      resolveEmbed: (target, fromPath) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(target, fromPath);
        const mime = file ? IMAGE_MIME[file.extension.toLowerCase()] : undefined;
        return file && mime ? { path: file.path, name: file.name, mime } : null;
      },
      linkCard: (url) => this.linkCards.get(url),
    };
  }

  /** Command "Create voice profile" (#83): creates Social/_voice.md from the template if needed, then opens it. */
  async openVoiceProfile(): Promise<void> {
    const { file, created } = await createVoiceProfile(this.app, this.settings.rootFolder);
    new Notice(created ? "Voice profile created. Fill it in; Claude reads it before drafting." : "Opened your voice profile.");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * A tap on a phone reminder (#70): `obsidian://osmm-post?vault=…&path=…&channel=…[&step=3]`. Every parameter is
   * untrusted: the note and channel must be in the index, nothing but the assisted flow is opened, and nothing is
   * marked by the link itself. Waits (bounded) for a cold start.
   */
  async openFromLink(params: Record<string, string>): Promise<void> {
    const path = typeof params.path === "string" ? params.path : "";
    const channel = typeof params.channel === "string" ? params.channel : "";
    if (!path || !channel) return;
    const late = await withTimeout(this.ready.then(() => false), LINK_READY_TIMEOUT_MS, true);
    if (this.unloaded) return;
    if (late) {
      new Notice("Social Planner is still starting. Tap the reminder again in a moment.");
      return;
    }
    const v = this.index.getVariant(path);
    if (!v) {
      new Notice("That post is no longer in this vault.");
      return;
    }
    // Fix round 1 (m3): a note Claude wrote while Obsidian was closed is held from a phone reminder too.
    if (heldForReview(v)) {
      new Notice(HELD_REFUSAL);
      return;
    }
    const name = this.channels.get(channel)?.name ?? channel;
    // M3 P7: never open (let alone mark) a channel that is not listed, or whose entry is frozen.
    if (!v.channels.includes(channel)) {
      new Notice(`${name} is not a channel of this post.`);
      return;
    }
    const d = effectiveDelivery(v, channel);
    if (!d) {
      new Notice(`${name} can't be posted from this link: its delivery entry in the note can't be read. Fix it in the note first.`);
      return;
    }
    const publish = this.uiContext().publish;
    if (params.step === "3") {
      if (d.status === "published" || d.status === "skipped") {
        new Notice(`${name} is already done for this post.`);
        return;
      }
      if (d.status === "publishing") {
        new Notice(`${name} is being published right now.`);
        return;
      }
      publish.openAssisted(path, [channel], 3);
      return;
    }
    // M2b P3: flush the editor and re-validate the exact text before the flow can copy or open anything.
    if (assistedQueue(v, this.settings.defaultStaggerMinutes, [channel]).length && !(await publish.freshTarget(path, channel))) return;
    if (this.unloaded) return;
    publish.openAssisted(path, [channel]);
  }

  uiContext(): OsmmContext {
    if (!this.ui) {
      const actions = new PlannerActions({
        app: this.app,
        writer: this.writer,
        factory: this.factory,
        channels: this.channels,
        index: this.index,
        settings: () => this.settings,
        now: () => Date.now(),
      });
      const composer = new ComposerActions({
        app: this.app,
        writer: this.writer,
        factory: this.factory,
        channels: this.channels,
        index: this.index,
        planner: actions,
        adapters: this.adapters,
        settings: () => this.settings,
        now: () => Date.now(),
      });
      const publish = new PublishActions({
        app: this.app,
        writer: this.writer,
        index: this.index,
        channels: this.channels,
        planner: actions,
        composer,
        adapters: this.adapters,
        clipboard: new ClipboardService(this.app),
        log: this.log,
        secrets: this.secrets,
        // Cleared on unload: the retry never runs and the delivery stays `failed` with its "retrying in" note.
        delay: (ms) =>
          new Promise((resolve) => {
            if (this.unloaded) return;
            const handle = window.setTimeout(() => {
              this.delays.delete(handle);
              resolve();
            }, ms);
            this.delays.add(handle);
          }),
        settings: () => this.settings,
        now: () => Date.now(),
        isPublisher: () => this.publisher.isPublisher(),
      });
      this.ui = {
        app: this.app,
        settings: this.settingsStore,
        snapshot: indexStore(this.index),
        now: clock(30_000),
        viewState: viewStateStore(this.app),
        channels: this.channels,
        actions,
        composer,
        publish,
        publisher: this.publisher,
        linkCards: this.linkCards,
      };
      actions.context = this.ui;
      publish.context = this.ui;
    }
    return this.ui;
  }
}
