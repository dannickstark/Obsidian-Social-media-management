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
import { PreviewGridView } from "./previews/PreviewGridView";
import { Secrets } from "./secrets/secrets";
import { loadDeviceSettings, type DeviceSettings } from "./settings/device";
import { migrateSettings, type OsmmSettings } from "./settings/settings";
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
  readonly adapters = new AdapterRegistry();
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

    this.addSettingTab(new OsmmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      this.index.start();
      await this.index.build();
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
      this.ui = {
        app: this.app,
        settings: this.settingsStore,
        snapshot: indexStore(this.index),
        now: clock(30_000),
        viewState: viewStateStore(this.app),
        channels: this.channels,
        actions,
        composer,
      };
      actions.context = this.ui;
    }
    return this.ui;
  }
}
