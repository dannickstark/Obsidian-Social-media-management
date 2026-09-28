import { normalizePath, PluginSettingTab, Setting, type App } from "obsidian";
import type OsmmPlugin from "../main";
import { formatTemplateLines, parseTemplateLines } from "../planner/templates";
import { mountSvelte, type Mounted } from "../ui/mount";
import { osmmContext } from "../ui/context";
import ChannelsSection from "./ChannelsSection.svelte";
import { parseMinutesList } from "./settings";

export class OsmmSettingTab extends PluginSettingTab {
  private channelsUi: Mounted | null = null;

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

    new Setting(containerEl).setName("Publishing").setHeading();

    new Setting(containerEl)
      .setName("Post late items automatically")
      .setDesc("If Obsidian was closed at a post's time, post it anyway when it is less late than the window below. Otherwise it waits in the Overdue tray.")
      .addToggle((t) =>
        t.setValue(s.autoPostLate).onChange(async (value) => {
          await this.osmm.updateSettings({ autoPostLate: value });
        }),
      );

    new Setting(containerEl)
      .setName("Late window (minutes)")
      .setDesc("From 1 to 240 minutes.")
      .addText((t) =>
        t.setValue(String(s.autoPostLateMinutes)).onChange(async (value) => {
          const n = Number(value.trim());
          if (Number.isInteger(n) && n >= 1 && n <= 240) await this.osmm.updateSettings({ autoPostLateMinutes: n });
        }),
      );

    new Setting(containerEl).setName("Channels").setHeading();
    const host = document.createElement("div");
    host.className = "osmm";
    containerEl.appendChild(host);
    this.channelsUi?.destroy();
    this.channelsUi = mountSvelte(host, ChannelsSection, {}, osmmContext(this.osmm.uiContext()));

    new Setting(containerEl).setName("Schedule templates").setHeading();
    for (const template of s.scheduleTemplates) {
      new Setting(containerEl)
        .setName(template.name)
        .setDesc("One step per line: T±days HH:mm platforms [label], e.g. T-7 09:00 linkedin,x Announce")
        .addTextArea((t) =>
          t.setValue(formatTemplateLines(template.steps)).onChange(async (value) => {
            const { steps, errors } = parseTemplateLines(value);
            if (errors.length) return;
            await this.osmm.updateSettings({
              scheduleTemplates: this.osmm.settings.scheduleTemplates.map((x) => (x.id === template.id ? { ...x, steps } : x)),
            });
          }),
        );
    }
  }

  override hide(): void {
    this.channelsUi?.destroy();
    this.channelsUi = null;
  }
}
