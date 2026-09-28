import { Notice, Plugin } from "obsidian";
import { writable, type Writable } from "svelte/store";
import "./styles/index.css";
import { ChannelRegistry } from "./channels/registry";
import { registerCommands } from "./commands";
import { ComposerActions } from "./composer/actions";
import { ComposerView } from "./composer/ComposerView";
import { indexStore } from "./index/stores";
import { SocialIndex } from "./index/socialIndex";
import { NoteFactory } from "./model/factory";
import { SafeWriter } from "./model/writer";
import { AdapterRegistry } from "./platforms/registry";
import { viewStateStore } from "./planner/viewState";
import { PublishActions } from "./publish/actions";
import { ClipboardService } from "./publish/clipboard";
import { MemoryLog } from "./publish/log";
import { PreviewGridView } from "./previews/PreviewGridView";
import { NotifiedLedger } from "./reminders/ledger";
import { Notifier } from "./reminders/notifier";
import { ReminderService } from "./reminders/service";
import { Scheduler } from "./scheduler/scheduler";
import { Secrets } from "./secrets/secrets";
import { loadDeviceSettings, type DeviceSettings } from "./settings/device";
import { autoPostLateMs, migrateSettings, type OsmmSettings } from "./settings/settings";
import { OsmmSettingTab } from "./settings/tab";
import { PlannerActions, VIEW_COMPOSER, VIEW_PLANNER, VIEW_PREVIEW_GRID, VIEW_SIDEBAR } from "./ui/actions";
import { clock, type OsmmContext } from "./ui/context";
import { SvelteRenderChild } from "./ui/SvelteView";
import { PlannerView } from "./views/PlannerView";
import { SidebarView } from "./views/SidebarView";
import CampaignTable from "./views/CampaignTable.svelte";

export default class OsmmPlugin extends Plugin {
  override settings!: OsmmSettings;
  settingsStore!: Writable<OsmmSettings>;
  device!: DeviceSettings;
  secrets!: Secrets;
  writer!: SafeWriter;
  factory!: NoteFactory;
  channels!: ChannelRegistry;
  index!: SocialIndex;
  scheduler!: Scheduler;
  reminders!: ReminderService;
  readonly adapters = new AdapterRegistry();
  readonly log = new MemoryLog();
  private unloaded = false;
  private ui: OsmmContext | undefined;

  override async onload(): Promise<void> {
    this.register(() => (this.unloaded = true));
    try {
      this.settings = migrateSettings(await this.loadData());
    } catch (error) {
      // e.g. settings saved by a newer schema: tell the user and stay inert rather than overwrite them.
      new Notice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.settingsStore = writable(this.settings);
    this.device = loadDeviceSettings(this.app);
    this.secrets = new Secrets(this.app);
    this.writer = new SafeWriter(this.app);
    this.factory = new NoteFactory(this.app, this.writer, { rootFolder: () => this.settings.rootFolder });
    this.channels = new ChannelRegistry({
      read: () => this.settings,
      write: async (next) => {
        this.settings = migrateSettings({ ...this.settings, ...next });
        this.settingsStore.set(this.settings);
        await this.saveSettings();
      },
    });
    this.index = new SocialIndex(this.app);
    this.register(() => this.index.stop());

    const ui = this.uiContext();
    const notifier = new Notifier({
      ledger: new NotifiedLedger(this.app, () => Date.now()),
      enabled: () => this.device.notifications,
      channelName: (id) => this.channels.get(id)?.name ?? id,
      noteTitle: (path) => this.index.getVariant(path)?.displayTitle ?? path,
      openAssisted: (path, ids) => void ui.publish.openAssisted(path, ids),
      openComposer: (path) => void ui.composer.openComposer(path),
    });
    ui.publish.notifier = notifier;
    this.reminders = new ReminderService({
      rows: () => ui.actions.rows(),
      channels: this.channels,
      adapters: this.adapters,
      settings: () => this.settings,
      notifier,
    });
    this.scheduler = new Scheduler({
      index: this.index,
      settings: () => this.settings,
      now: () => Date.now(),
      // M3 (#26) replaces this with the publisher-device setting; until then every device publishes.
      isPublisher: () => true,
      autoPostLateMs: () => autoPostLateMs(this.settings),
      publish: ui.publish,
      onTick: (now, previous) =>
        Promise.resolve()
          .then(() => void this.reminders.tick(now, previous))
          .catch((e) => void new Notice(e instanceof Error ? e.message : String(e), 0)),
      warn: (message) => new Notice(message, 0),
    });
    this.register(() => this.scheduler.stop());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.scheduler.tick();
    });

    this.addSettingTab(new OsmmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      this.index.start();
      await this.index.build();
      if (this.unloaded) return;
      await this.scheduler.reconcile();
      if (this.unloaded) return;
      this.scheduler.start();
      void this.scheduler.tick();
    });

    this.registerView(VIEW_PLANNER, (leaf) => new PlannerView(leaf, this.uiContext()));
    this.registerHoverLinkSource(VIEW_PLANNER, { display: "Social planner", defaultMod: true });
    this.registerView(VIEW_SIDEBAR, (leaf) => new SidebarView(leaf, this.uiContext()));
    this.registerView(VIEW_PREVIEW_GRID, (leaf) => new PreviewGridView(leaf, this.uiContext()));
    this.registerView(VIEW_COMPOSER, (leaf) => new ComposerView(leaf, this.uiContext()));

    registerCommands(this);

    this.registerMarkdownCodeBlockProcessor("social-variants", (_source, el, ctx) => {
      ctx.addChild(new SvelteRenderChild(el, CampaignTable, { campaignPath: ctx.sourcePath }, this.uiContext()));
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
        delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        settings: () => this.settings,
        now: () => Date.now(),
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
      };
      actions.context = this.ui;
      publish.context = this.ui;
    }
    return this.ui;
  }
}
