import { describe, expect, it, vi } from "vitest";
import type { PublishDeps } from "../src/publish/actions";
import type { Notifier } from "../src/reminders/notifier";
import { App, Notice, Setting, type TextComponent, type DropdownComponent, type ToggleComponent } from "./fakes/obsidian";
import OsmmPlugin from "../src/main";
import { formatDateTime } from "../src/model/dates";
import { indexed, nextChange, settle, writeNote } from "./helpers";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };

async function loaded() {
  const app = new App();
  const plugin = new OsmmPlugin(app as never, manifest);
  await plugin.load();
  await settle();
  return { app, plugin };
}

describe("OsmmPlugin unload (final review Minor 7)", () => {
  it("clears pending retry delays and disposes the notifier", async () => {
    const { plugin } = await loaded();
    const publish = plugin.uiContext().publish;
    const dispose = vi.spyOn(publish.notifier as Notifier, "dispose");
    const set = vi.spyOn(window, "setTimeout");
    const clear = vi.spyOn(window, "clearTimeout");
    void (publish as unknown as { deps: PublishDeps }).deps.delay(15 * 60_000);
    const handle = set.mock.results.at(-1)!.value;
    plugin.unload();
    expect(clear).toHaveBeenCalledWith(handle);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("OsmmPlugin", () => {
  it("records publish attempts in Social/_log.md (#65)", async () => {
    const { app, plugin } = await loaded();
    await plugin.log.append({ at: Date.UTC(2026, 9, 8, 15, 30), path: "Social/Posts/A.md", channelId: "li/me", result: "published", url: "https://www.linkedin.com/feed/update/1" });
    const file = app.vault.getFileByPath("Social/_log.md")!;
    expect(await app.vault.read(file)).toContain("- 2026-10-08T17:30:00+02:00 · li/me · [[Social/Posts/A]] · published · https://www.linkedin.com/feed/update/1");
    plugin.unload();
  });

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

  it("runs the startup check once this device becomes the publisher (#26)", async () => {
    const app = new App();
    await writeNote(app as never, "Social/Posts/P.md", {
      type: "social-post",
      platform: "bluesky",
      channels: ["bs/you"],
      status: "scheduled",
      scheduled_at: "2026-10-08T10:00:00+02:00",
      deliveries: { "bs/you": { status: "publishing", at: "2026-10-08T10:00:00+02:00" } },
    }, "Hi");
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    await settle(20);
    expect(plugin.publisher.isPublisher()).toBe(false);
    expect(plugin.index.getVariant("Social/Posts/P.md")?.deliveries["bs/you"]?.status).toBe("publishing");
    await plugin.publisher.claim();
    await indexed(plugin.index, () => plugin.index.getVariant("Social/Posts/P.md")?.deliveries["bs/you"]?.status === "check_needed");
    plugin.unload();
  });

  describe("a role change during the startup reconcile (Task 2 follow-up)", () => {
    const P = "Social/Posts/P.md";
    const Q = "Social/Posts/Q.md";

    /** A stuck `publishing` delivery and a due one; the layout-ready callback is held so the test drives start-up. */
    async function startingUp() {
      const app = new App();
      const at = formatDateTime(Date.now());
      const post = (deliveries: Record<string, unknown>) => ({ type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: at, deliveries });
      await writeNote(app as never, P, post({ "bs/you": { status: "publishing", at } }), "Hi");
      await writeNote(app as never, Q, post({ "bs/you": { status: "scheduled" } }), "Hi");
      await settle();
      let ready: (() => Promise<void>) | undefined;
      app.workspace.onLayoutReady = (cb) => {
        ready = cb as () => Promise<void>;
      };
      const plugin = new OsmmPlugin(app as never, manifest);
      await plugin.load();
      const publish = plugin.uiContext().publish;
      const checked = vi.spyOn(publish, "markCheckNeeded");
      const dispatched = vi.spyOn(publish, "dispatch");
      const reconcile = plugin.scheduler.reconcile.bind(plugin.scheduler);
      return { plugin, checked, dispatched, reconcile, start: () => ready!() };
    }

    async function expectCheckedBeforeDispatch(t: Awaited<ReturnType<typeof startingUp>>) {
      await indexed(t.plugin.index, () => t.plugin.index.getVariant(P)?.deliveries["bs/you"]?.status === "check_needed");
      expect(t.checked).toHaveBeenCalledWith(P, "bs/you");
      expect(t.dispatched).toHaveBeenCalledOnce();
      expect(t.checked.mock.invocationCallOrder[0]!).toBeLessThan(t.dispatched.mock.invocationCallOrder[0]!);
      t.plugin.unload();
    }

    it("checks a stuck publish before any dispatch when the role is claimed while the startup reconcile is pending", async () => {
      const t = await startingUp();
      vi.spyOn(t.plugin.scheduler, "reconcile").mockImplementationOnce(async () => {
        const summary = await t.reconcile();
        await t.plugin.publisher.claim();
        return summary;
      });
      await t.start();
      await expectCheckedBeforeDispatch(t);
    });

    it("reconciles again when the role is lost and regained while the startup reconcile runs", async () => {
      const t = await startingUp();
      await t.plugin.publisher.claim();
      vi.spyOn(t.plugin.scheduler, "reconcile").mockImplementationOnce(async () => {
        await t.plugin.publisher.release();
        const summary = await t.reconcile();
        await t.plugin.publisher.claim();
        return summary;
      });
      await t.start();
      await expectCheckedBeforeDispatch(t);
    });
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
