import { normalizePath, PluginSettingTab, Setting, type App } from "obsidian";
import type OsmmPlugin from "../main";
import { parseMinutesList } from "./settings";

export class OsmmSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly osmm: OsmmPlugin,
  ) {
    super(app, osmm);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.osmm.settings;

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Root folder")
      .setDesc("New campaigns and standalone posts are created here.")
      .addText((t) =>
        t
          .setPlaceholder("Social")
          .setValue(s.rootFolder)
          .onChange(async (value) => {
            await this.osmm.updateSettings({ rootFolder: normalizePath(value.trim() || "Social") });
          }),
      );

    new Setting(containerEl)
      .setName("Week starts on")
      .addDropdown((d) =>
        d
          .addOption("1", "Monday")
          .addOption("0", "Sunday")
          .setValue(String(s.weekStartsOn))
          .onChange(async (value) => {
            await this.osmm.updateSettings({ weekStartsOn: value === "0" ? 0 : 1 });
          }),
      );

    new Setting(containerEl)
      .setName("Default reminders")
      .setDesc("Minutes before a post, comma-separated (e.g. 60, 10).")
      .addText((t) =>
        t.setValue(s.defaultReminders.join(", ")).onChange(async (value) => {
          const parsed = parseMinutesList(value);
          if (parsed) await this.osmm.updateSettings({ defaultReminders: parsed });
        }),
      );

    new Setting(containerEl)
      .setName("Default stagger")
      .setDesc("Minutes between channels when one post goes to several channels.")
      .addText((t) =>
        t.setValue(String(s.defaultStaggerMinutes)).onChange(async (value) => {
          if (/^\d+$/.test(value.trim())) await this.osmm.updateSettings({ defaultStaggerMinutes: Number(value.trim()) });
        }),
      );
  }
}
