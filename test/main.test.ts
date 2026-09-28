import { describe, expect, it } from "vitest";
import { App, Notice, Setting, type TextComponent, type DropdownComponent, type ToggleComponent } from "./fakes/obsidian";
import OsmmPlugin from "../src/main";
import { nextChange, settle } from "./helpers";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };

async function loaded() {
  const app = new App();
  const plugin = new OsmmPlugin(app as never, manifest);
  await plugin.load();
  await settle();
  return { app, plugin };
}

describe("OsmmPlugin", () => {
  it("wires services and indexes notes created through the factory", async () => {
    const { plugin } = await loaded();
    const change = nextChange(plugin.index);
    await plugin.factory.createCampaign({ title: "Event X" });
    await change;
    expect(plugin.index.campaigns().map((c) => c.path)).toEqual(["Social/Event X/Event X.md"]);
    plugin.unload();
  });

  it("persists settings updates", async () => {
    const { plugin } = await loaded();
    await plugin.updateSettings({ rootFolder: "Content/Social" });
    expect((await plugin.loadData()).rootFolder).toBe("Content/Social");
    plugin.unload();
  });

  it("renders the General settings and applies edits", async () => {
    const { plugin } = await loaded();
    Setting.all = [];
    (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!.display();
    const byName = (n: string) => Setting.all.find((s) => s.name === n)!;
    expect(Setting.all.map((s) => s.name)).toEqual([
      "General",
      "Root folder",
      "Week starts on",
      "Default reminders",
      "Default stagger",
      "Publishing",
      "Post late items automatically",
      "Late window (minutes)",
      "Desktop notifications on this device",
      "Channels",
      "Schedule templates",
      "Launch",
    ]);
    await (byName("Default reminders").components[0] as TextComponent).change("30, 5");
    await (byName("Week starts on").components[0] as DropdownComponent).change("0");
    expect(plugin.settings.defaultReminders).toEqual([30, 5]);
    expect(plugin.settings.weekStartsOn).toBe(0);
    await (byName("Default reminders").components[0] as TextComponent).change("soon");
    expect(plugin.settings.defaultReminders).toEqual([30, 5]);
    await (byName("Post late items automatically").components[0] as ToggleComponent).toggle(true);
    await (byName("Late window (minutes)").components[0] as TextComponent).change("45");
    expect([plugin.settings.autoPostLate, plugin.settings.autoPostLateMinutes]).toEqual([true, 45]);
    plugin.unload();
  });

  it("reloads settings synced from another device (final review F4)", async () => {
    const { plugin } = await loaded();
    const channel = { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" };
    await plugin.saveData({ ...plugin.settings, channels: [channel] });
    await plugin.onExternalSettingsChange();
    expect(plugin.channels.list().map((c) => c.id)).toEqual(["li/me"]);
    plugin.unload();
  });

  it("stops the index on unload", async () => {
    const { app, plugin } = await loaded();
    plugin.unload();
    let fired = false;
    plugin.index.onChange(() => (fired = true));
    await app.vault.createFolder("Social");
    await app.vault.create("Social/p.md", "---\ntype: social-post\nplatform: x\n---\n");
    await settle(80);
    expect(fired).toBe(false);
  });

  it("shows a notice and stops loading when settings come from a newer schema (final review F5.4)", async () => {
    const app = new App();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.saveData({ schemaVersion: 99 });
    Notice.messages = [];
    await expect(plugin.load()).resolves.toBeUndefined();
    expect(Notice.messages).toEqual([expect.stringMatching(/newer version/)]);
    expect(plugin.index).toBeUndefined();
    plugin.unload();
  });

  it("does not build or start the index when unloaded before the layout is ready (final review F5.4)", async () => {
    const app = new App();
    await app.vault.createFolder("Social");
    await app.vault.create("Social/p.md", "---\ntype: social-post\nplatform: x\n---\n");
    await settle();
    let ready: (() => unknown) | undefined;
    app.workspace.onLayoutReady = (cb) => {
      ready = cb;
    };
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    plugin.unload();
    await ready?.();
    expect(plugin.index.variants()).toEqual([]);
    let fired = false;
    plugin.index.onChange(() => (fired = true));
    await app.vault.create("Social/q.md", "---\ntype: social-post\nplatform: x\n---\n");
    await settle(80);
    expect(fired).toBe(false);
  });
});
