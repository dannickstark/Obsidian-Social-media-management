import { Plugin } from "obsidian";
import "./styles/index.css";
import { ChannelRegistry } from "./channels/registry";
import { SocialIndex } from "./index/socialIndex";
import { NoteFactory } from "./model/factory";
import { SafeWriter } from "./model/writer";
import { Secrets } from "./secrets/secrets";
import { loadDeviceSettings, type DeviceSettings } from "./settings/device";
import { migrateSettings, type OsmmSettings } from "./settings/settings";
import { OsmmSettingTab } from "./settings/tab";

export default class OsmmPlugin extends Plugin {
  override settings!: OsmmSettings;
  device!: DeviceSettings;
  secrets!: Secrets;
  writer!: SafeWriter;
  factory!: NoteFactory;
  channels!: ChannelRegistry;
  index!: SocialIndex;

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.device = loadDeviceSettings(this.app);
    this.secrets = new Secrets(this.app);
    this.writer = new SafeWriter(this.app);
    this.factory = new NoteFactory(this.app, this.writer, { rootFolder: () => this.settings.rootFolder });
    this.channels = new ChannelRegistry({
      read: () => this.settings,
      write: async (next) => {
        this.settings = { ...this.settings, ...next };
        await this.saveSettings();
      },
    });
    this.index = new SocialIndex(this.app);
    this.register(() => this.index.stop());

    this.addSettingTab(new OsmmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      this.index.start();
      await this.index.build();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async updateSettings(patch: Partial<Omit<OsmmSettings, "schemaVersion">>): Promise<void> {
    this.settings = migrateSettings({ ...this.settings, ...patch });
    await this.saveSettings();
  }
}
