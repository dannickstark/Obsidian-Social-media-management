import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Notice, setPlatform } from "./fakes/obsidian";
import { browser } from "./fakes/browser";
import OsmmPlugin from "../src/main";
import { browserClipboard, isMobile } from "../src/publish/clipboard";
import { NotifiedLedger } from "../src/reminders/ledger";
import { Notifier } from "../src/reminders/notifier";
import { VIEW_COMPOSER, VIEW_PLANNER, VIEW_PREVIEW_GRID, VIEW_SIDEBAR } from "../src/ui/actions";
import { indexed, settle, writeNote } from "./helpers";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };
const saved = { Notification: globalThis.Notification };

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  Object.assign(globalThis, saved);
});

describe("on a phone (#27)", () => {
  it.each(["iphone", "android"] as const)("the plugin loads with no errors on %s", async (kind) => {
    setPlatform(kind);
    Object.assign(globalThis, { Notification: undefined });
    const app = new App();
    await writeNote(app as never, "Social/Posts/P.md", { type: "social-post", platform: "x", channels: [], status: "draft" }, "Hi");
    await settle();
    Notice.messages = [];
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    for (const view of [VIEW_PLANNER, VIEW_SIDEBAR, VIEW_PREVIEW_GRID, VIEW_COMPOSER]) expect(app.workspace.viewFactories.has(view)).toBe(true);
    expect(plugin.device.deviceName).toBe(kind === "iphone" ? "iPhone" : "Android phone");
    expect(Notice.messages.filter((m) => /error|cannot|undefined/i.test(m))).toEqual([]);
    plugin.unload();
  });

  it("never reaches for Electron, Buffer or the file manager", async () => {
    setPlatform("iphone");
    const electron = vi.fn();
    (window as unknown as { require: unknown }).require = electron;
    const app = new App();
    const env = browserClipboard(app as never);
    expect(await env.writeImage(new ArrayBuffer(4), "image/jpeg")).toBe(false);
    expect(env.reveal("Social/a.png")).toBe(false);
    expect(electron).not.toHaveBeenCalled();
    expect(isMobile()).toBe(true);
  });

  it("keeps reminders in-app instead of raising system notifications", () => {
    setPlatform("android");
    browser.focused = false;
    const notifier = new Notifier({
      ledger: new NotifiedLedger(new App() as never, () => 1),
      enabled: () => true,
      channelName: () => "@you",
      noteTitle: () => "Hello",
      openAssisted: () => undefined,
      openComposer: () => undefined,
    });
    notifier.reminder({ key: "k", path: "p.md", channelId: "bs/you", at: 1, minutes: 10, title: "Hello" });
    expect(Notice.messages.at(-1)).toContain("In 10 min: Hello");
    expect(browser.notifications).toEqual([]);
  });
});
