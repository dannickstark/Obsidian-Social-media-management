import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { PublishDeps } from "../src/publish/actions";
import { App, Modal, Notice, requestUrlMock, setPlatform, Setting, type ButtonComponent, type TextComponent, type DropdownComponent, type ToggleComponent } from "./fakes/obsidian";
import { browser } from "./fakes/browser";
import OsmmPlugin, { LINK_READY_TIMEOUT_MS } from "../src/main";
import { formatDateTime } from "../src/model/dates";
import { CLOSED } from "../src/mcp/approval";
import { indexed, nextChange, settle, writeNote } from "./helpers";
import { freePort, portIsFree } from "./mcp/net";
import { NTFY } from "./reminders/ntfy/fixtures";
import { WITHDRAW_WAIT_MS } from "../src/reminders/ntfy/booker";

const manifest = { id: "osmm-social-planner", name: "OSMM", version: "0.1.0", minAppVersion: "1.11.4", description: "", author: "" };

/** The user leaves a settings field: pending Server/Topic edits are applied (final review 1). */
async function blur(setting: Setting): Promise<void> {
  (setting.components[0] as TextComponent).inputEl.dispatchEvent(new FocusEvent("blur"));
  await settle(20);
}

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
    // M3 P6: the publish notifier is a fan-out (desktop + phone); the desktop Notifier stays reachable.
    const dispose = vi.spyOn(plugin.notifier, "dispose");
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
  it("tells the user at start-up about notes Claude wrote while Obsidian was closed (#84)", async () => {
    const app = new App();
    await writeNote(app as never, "Social/Posts/Offline.md", { type: "social-post", platform: "mastodon", title: "Offline", channels: [], status: "ready", review: "claude" }, "Hi");
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await settle();
    expect(Notice.messages.some((m) => m.startsWith("1 post written by Claude needs your review."))).toBe(true);
    plugin.unload();
  });

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
      "This device",
      "Device name",
      "Publisher device",
      "Publishing",
      "Post late items automatically",
      "Late window (minutes)",
      "Desktop notifications on this device",
      "Phone reminders (ntfy)",
      "About phone reminders",
      "Phone reminders on this device",
      "Claude Code",
      "About Claude Code",
      "MCP server on this device",
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

  it("names this device and makes it the publisher from the settings (#26)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    await (last("Device name").components[0] as TextComponent).change("Studio iMac");
    expect(plugin.device.deviceName).toBe("Studio iMac");
    expect(app.loadLocalStorage("osmm-device")).toMatchObject({ deviceName: "Studio iMac" });
    expect(last("Publisher device").desc).toContain("No device publishes yet");
    await (last("Publisher device").components[0] as ButtonComponent).click();
    expect(plugin.settings.publisher).toMatchObject({ deviceId: plugin.device.deviceId, name: "Studio iMac" });

    await plugin.updateSettings({ publisher: { deviceId: "other", name: "Work laptop", since: 1 } });
    tab.display();
    expect(last("Publisher device").desc).toContain("Publishing happens on Work laptop.");
    const clicked = (last("Publisher device").components[0] as ButtonComponent).click();
    (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
    await clicked;
    expect(plugin.publisher.isPublisher()).toBe(true);
    plugin.unload();
  });

  it("sets up phone reminders with the topic in secret storage only (#71)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    expect(last("About phone reminders").desc).toContain("anyone who knows the topic can read");
    // M3 P12: the privacy copy says what a push carries.
    expect(last("About phone reminders").desc).toContain("the post text (inside the pre-filled link)");
    await (last("Phone reminders on this device").components[0] as ToggleComponent).toggle(true);
    const topic = app.secretStorage.getSecret("osmm-ntfy-topic")!;
    expect(topic).toMatch(/^osmm-[a-z0-9]{24}$/);
    expect(plugin.device.ntfy.enabled).toBe(true);
    expect(Setting.all.map((s) => s.name)).toEqual(expect.arrayContaining(["Server", "Topic", "Access token", "Set up your phone", "Send a test notification", "Push publishing results"]));
    expect((last("Topic").components[0] as TextComponent).value).toBe(topic);

    await (last("Access token").components[0] as TextComponent).change(" tk_SECRETTOKEN ");
    expect(app.secretStorage.getSecret("osmm-ntfy-token")).toBe("tk_SECRETTOKEN");
    expect((last("Access token").components[0] as TextComponent).inputEl.type).toBe("password");
    for (const stored of [JSON.stringify(await plugin.loadData()), JSON.stringify(app.loadLocalStorage("osmm-device"))]) {
      expect(stored).not.toContain(topic);
      expect(stored).not.toContain("tk_SECRETTOKEN");
    }

    Notice.messages = [];
    requestUrlMock.queue.push(NTFY.published, NTFY.forbidden);
    await (last("Send a test notification").components[0] as ButtonComponent).click();
    await (last("Send a test notification").components[0] as ButtonComponent).click();
    expect(requestUrlMock.calls[0]!.headers).toEqual({ Authorization: "Bearer tk_SECRETTOKEN" });
    expect(Notice.messages[0]).toBe("Test sent. It should reach your phone within a few seconds.");
    expect(Notice.messages[1]).toMatch(/^Couldn't send the test: The ntfy server refused this device/);
    expect(Notice.messages.join(" ")).not.toContain(topic);

    await (last("Server").components[0] as TextComponent).change("https://push.example.org/");
    await blur(last("Server"));
    expect(plugin.device.ntfy.server).toBe("https://push.example.org");
    await (last("Server").components[0] as TextComponent).change("not a server");
    await blur(last("Server"));
    expect(plugin.device.ntfy.server).toBe("https://push.example.org");
    // Final review 10 and 5: the privacy copy names the Obsidian links; the results copy covers every API publish.
    expect(last("About phone reminders").desc).toContain("the vault name and the note's path (in the Obsidian links)");
    expect(last("Push publishing results").desc).toBe("Also push a confirmation when a post goes out through a platform connection, and an alert when one fails (sent by the publisher device).");
    plugin.unload();
  });

  it("warns when a token would travel over plain http (Task 5 ruling)", async () => {
    const { plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    Setting.all = [];
    tab.display();
    const warning = "unencrypted";
    await (last("Server").components[0] as TextComponent).change("http://192.168.1.20:8080");
    expect(last("Access token").desc).not.toContain(warning);
    await (last("Access token").components[0] as TextComponent).change("tk_SECRETTOKEN");
    expect(last("Access token").desc).toContain(warning);
    expect(last("Access token").desc).not.toContain("tk_SECRETTOKEN");
    await (last("Server").components[0] as TextComponent).change("https://push.example.org");
    expect(last("Access token").desc).not.toContain(warning);
    tab.display();
    expect(last("Access token").desc).not.toContain(warning);
    await (last("Server").components[0] as TextComponent).change("http://192.168.1.20:8080");
    tab.display();
    expect(last("Access token").desc).toContain(warning);
    plugin.unload();
  });

  it("forgets the bookings only for a real Server or Topic change, never for the token (final review 1)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    Setting.all = [];
    tab.display();
    const forget = vi.spyOn(plugin.phone, "forget");
    const withdraw = vi.spyOn(plugin.phone, "withdraw");
    await (last("Server").components[0] as TextComponent).change("https://ntfy.sh/");
    await blur(last("Server"));
    await (last("Topic").components[0] as TextComponent).change(" osmm-oldtopic ");
    await blur(last("Topic"));
    await (last("Access token").components[0] as TextComponent).change("tk_x");
    await blur(last("Access token"));
    expect(app.secretStorage.getSecret("osmm-ntfy-token")).toBe("tk_x");
    expect([forget.mock.calls.length, withdraw.mock.calls.length]).toEqual([0, 0]);

    // Typed key by key: nothing is applied until 1.5 s after the last keystroke (or on blur), and then only once.
    vi.useFakeTimers();
    try {
      for (const typed of ["osmm-n", "osmm-new", "osmm-newt", "osmm-newtopic"]) {
        await (last("Topic").components[0] as TextComponent).change(typed);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(app.secretStorage.getSecret("osmm-ntfy-topic")).toBe("osmm-oldtopic");
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(app.secretStorage.getSecret("osmm-ntfy-topic")).toBe("osmm-newtopic");
    expect([forget.mock.calls.length, withdraw.mock.calls.length]).toEqual([1, 1]);
    plugin.unload();
  });

  it("moves booked reminders to a new Server or Topic: cancelled on the old target first, rebooked after the hold (final review 1)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    await writeNote(app as never, "Social/Posts/R.md", { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + 2 * 3_600_000), reminders: [60] }, "Hi");
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    requestUrlMock.queue.push(NTFY.scheduled);
    await plugin.publisher.claim();
    await settle(50);
    expect(requestUrlMock.calls).toHaveLength(1);
    Setting.all = [];
    tab.display();

    requestUrlMock.queue.push(NTFY.cancelled);
    await (last("Topic").components[0] as TextComponent).change("osmm-newtopic");
    await blur(last("Topic"));
    expect(requestUrlMock.calls[1]).toMatchObject({ method: "DELETE", url: `https://ntfy.sh/osmm-oldtopic/${JSON.parse(NTFY.scheduled().text).id}` });
    expect(app.secretStorage.getSecret("osmm-ntfy-topic")).toBe("osmm-newtopic");
    expect((await plugin.phone.sync()).booked).toEqual([]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      requestUrlMock.queue.push(NTFY.scheduled);
      expect((await plugin.phone.sync()).booked).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    expect(JSON.parse(String(requestUrlMock.calls[2]!.body)).topic).toBe("osmm-newtopic");
    plugin.unload();
  });

  it("runs New topic after a Server/Topic edit still being applied, so the shown and stored topics agree (re-review 2)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    Setting.all = [];
    tab.display();
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => (finishFirst = resolve));
    const empty = { booked: [], cancelled: [], leftStale: [], failed: [] };
    vi.spyOn(plugin.phone, "withdraw")
      .mockImplementationOnce(() => first.then(() => empty))
      .mockResolvedValue(empty);
    await (last("Topic").components[0] as TextComponent).change("osmm-typedtopic");
    await blur(last("Topic"));
    const clicked = (last("Topic").components[2] as ButtonComponent).click();
    (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
    await settle(20);
    finishFirst();
    await clicked;
    await settle(20);
    const stored = app.secretStorage.getSecret("osmm-ntfy-topic")!;
    expect(stored).toMatch(/^osmm-[a-z0-9]{24}$/);
    expect((last("Topic").components[0] as TextComponent).value).toBe(stored);
    plugin.unload();
  });

  it("saves a Server/Topic edit still waiting for its pause when the plugin unloads (re-review 3)", async () => {
    const { app, plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    app.saveLocalStorage("osmm-ntfy-bookings", { "x.md#bs/you@1:10": { rowKey: "x.md#bs/you", minutes: 10, messageId: "m1", fireAt: Date.now() + 3_600_000, version: 1 } });
    Setting.all = [];
    tab.display();
    await (last("Server").components[0] as TextComponent).change("https://push.example.org");
    await (last("Topic").components[0] as TextComponent).change("osmm-typedtopic");
    plugin.unload();
    expect((app.loadLocalStorage("osmm-device") as { ntfy: { server: string } }).ntfy.server).toBe("https://push.example.org");
    expect(app.secretStorage.getSecret("osmm-ntfy-topic")).toBe("osmm-typedtopic");
    // The old target's bookings are forgotten, so the next start never cancels them on the new target.
    expect(app.loadLocalStorage("osmm-ntfy-bookings")).toBeNull();
  });

  it("points to the phone reminder setup after this device becomes the publisher without them (final review 3)", async () => {
    const { plugin } = await loaded();
    Notice.messages = [];
    await plugin.publisher.claim();
    expect(Notice.messages).toContain("Phone reminders are off on this device — set them up under Phone reminders (ntfy).");
    await plugin.publisher.release();
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    Notice.messages = [];
    await plugin.publisher.claim();
    expect(Notice.messages).not.toContain("Phone reminders are off on this device — set them up under Phone reminders (ntfy).");
    plugin.unload();
  });

  it("shows a Notice when keeping the publisher name in step fails (final review 13)", async () => {
    const { plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    vi.spyOn(plugin.publisher, "renamed").mockRejectedValue(new Error("Couldn't save the settings."));
    Notice.messages = [];
    await (last("Device name").components[0] as TextComponent).change("Studio iMac");
    expect(Notice.messages).toEqual(["Couldn't update the publisher name: Couldn't save the settings."]);
    plugin.unload();
  });

  it("turns phone reminders off without waiting for the cancels (Task 9 ruling)", async () => {
    const { plugin } = await loaded();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    Setting.all = [];
    tab.display();
    const withdraw = vi.spyOn(plugin.phone, "withdraw").mockReturnValue(new Promise(() => undefined));
    await (last("Phone reminders on this device").components[0] as ToggleComponent).toggle(false);
    expect(withdraw).toHaveBeenCalledOnce();
    expect(plugin.device.ntfy.enabled).toBe(false);
    expect(Setting.all.filter((s) => s.name === "Server")).toHaveLength(1);
    plugin.unload();
  });

  it("books phone reminders on the publisher and makes no request when they are off (#67)", async () => {
    const { app, plugin } = await loaded();
    await writeNote(app as never, "Social/Posts/R.md", { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + 2 * 3_600_000), reminders: [60] }, "Hi");
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    await plugin.scheduler.tick();
    await plugin.phone.sync();
    expect(requestUrlMock.calls).toEqual([]);

    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-maintesttopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    await plugin.phone.sync();
    expect(requestUrlMock.calls).toEqual([]); // enabled, but not the publisher

    // Becoming the publisher runs the startup check and a tick, and the tick books the reminder.
    requestUrlMock.queue.push(NTFY.scheduled);
    await plugin.publisher.claim();
    await settle(50);
    expect(requestUrlMock.calls).toHaveLength(1);
    const body = JSON.parse(String(requestUrlMock.calls[0]!.body));
    expect(body).toMatchObject({ topic: "osmm-maintesttopic", title: "In 1 h · Bluesky" });
    expect(Number(body.delay) * 1000).toBeGreaterThan(Date.now());
    expect((await plugin.phone.sync()).booked).toEqual([]);
    expect(JSON.stringify(app.loadLocalStorage("osmm-ntfy-bookings"))).not.toContain("osmm-maintesttopic");

    // Losing the role cancels the booking at once (the booker follows the publisher role).
    requestUrlMock.queue.push(NTFY.cancelled);
    await plugin.publisher.release();
    await settle(50);
    expect(requestUrlMock.calls).toHaveLength(2);
    expect(requestUrlMock.calls[1]!.method).toBe("DELETE");
    plugin.unload();
  });

  it("links phone reminders through Obsidian once the server can't cancel pushes (Task 8 ruling, P9)", async () => {
    const { app, plugin } = await loaded();
    const post = (hours: number) => ({ type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + hours * 3_600_000), reminders: [60] });
    await plugin.updateSettings({ channels: [{ id: "bs/you", platform: "bluesky", name: "@you", kind: "account", avatarColor: "#c9c3b8", method: "assisted" }] as never });
    await writeNote(app as never, "Social/Posts/R.md", post(2), "Hi");
    await indexed(plugin.index, () => plugin.index.variants().length === 1);
    app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-maintesttopic");
    plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
    requestUrlMock.queue.push(NTFY.scheduled);
    await plugin.publisher.claim();
    await settle(50);
    expect(JSON.parse(String(requestUrlMock.calls[0]!.body)).click).toMatch(/^https:\/\//);

    vi.spyOn(plugin.phone, "cancelSupported").mockReturnValue(false);
    await writeNote(app as never, "Social/Posts/S.md", post(3), "Hi");
    await indexed(plugin.index, () => plugin.index.variants().length === 2);
    requestUrlMock.queue.push(NTFY.scheduled);
    expect((await plugin.phone.sync()).booked).toHaveLength(1);
    expect(JSON.parse(String(requestUrlMock.calls[1]!.body)).click).toMatch(/^obsidian:\/\/osmm-post\?/);
    plugin.unload();
  });

  describe("New topic, unload and the http warning (Task 9 fix round 1)", () => {
    const tabOf = (plugin: OsmmPlugin) => (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    const newTopic = () => last("Topic").components[2] as ButtonComponent;
    const confirm = () => (Modal.opened.at(-1)!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();

    /** A publisher with phone reminders on and one assisted post whose reminder is booked. */
    async function booked() {
      const { app, plugin } = await loaded();
      await writeNote(app as never, "Social/Posts/R.md", { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + 2 * 3_600_000), reminders: [60] }, "Hi");
      await indexed(plugin.index, () => plugin.index.variants().length === 1);
      app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
      plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
      requestUrlMock.queue.push(NTFY.scheduled);
      await plugin.publisher.claim();
      await settle(50);
      expect(requestUrlMock.calls).toHaveLength(1);
      Setting.all = [];
      tabOf(plugin).display();
      return { app, plugin };
    }

    it("books on the new topic even when the old push could not be cancelled", async () => {
      const { app, plugin } = await booked();
      requestUrlMock.queue.push(NTFY.methodNotAllowed);
      const clicked = newTopic().click();
      confirm();
      await clicked;
      expect(requestUrlMock.calls[1]!.method).toBe("DELETE");
      const topic = app.secretStorage.getSecret("osmm-ntfy-topic")!;
      expect(topic).not.toBe("osmm-oldtopic");
      // Held for a minute after the change (M3 P13), then booked again on the new topic.
      expect((await plugin.phone.sync()).booked).toEqual([]);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
      try {
        requestUrlMock.queue.push(NTFY.scheduled);
        expect((await plugin.phone.sync()).booked).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
      expect(JSON.parse(String(requestUrlMock.calls.at(-1)!.body)).topic).toBe(topic);
      plugin.unload();
    });

    it("sets the new topic even when the cancels never finish", async () => {
      const { app, plugin } = await booked();
      vi.spyOn(plugin.phone, "withdraw").mockReturnValue(new Promise(() => undefined));
      vi.useFakeTimers();
      try {
        const clicked = newTopic().click();
        confirm();
        await vi.advanceTimersByTimeAsync(WITHDRAW_WAIT_MS);
        await clicked;
      } finally {
        vi.useRealTimers();
      }
      expect(app.secretStorage.getSecret("osmm-ntfy-topic")).not.toBe("osmm-oldtopic");
      plugin.unload();
    });

    it("sends nothing more after unload while a run is in flight", async () => {
      const { app, plugin } = await loaded();
      const post = (h: number) => ({ type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(Date.now() + h * 3_600_000), reminders: [60] });
      await writeNote(app as never, "Social/Posts/R.md", post(2), "Hi");
      await writeNote(app as never, "Social/Posts/S.md", post(3), "Hi");
      await indexed(plugin.index, () => plugin.index.variants().length === 2);
      app.secretStorage.setSecret("osmm-ntfy-topic", "osmm-oldtopic");
      plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
      vi.spyOn(plugin.phone, "sync").mockResolvedValue({ booked: [], cancelled: [], leftStale: [], failed: [] });
      await plugin.publisher.claim();
      await settle(20);
      vi.mocked(plugin.phone.sync).mockRestore();
      let release: (() => void) | undefined;
      const publish = vi.spyOn(plugin.ntfy, "publish").mockResolvedValue({ id: "Zr0Jk2fA9c", at: 0 }).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { id: "Zr0Jk2fA9b", at: 0 };
      });
      const run = plugin.phone.sync();
      await settle(20);
      expect(publish).toHaveBeenCalledOnce();
      plugin.unload();
      release!();
      await run;
      await plugin.phone.sync();
      expect(publish).toHaveBeenCalledOnce();
    });

    it("warns about a token on an http server whatever the scheme's case", async () => {
      const { plugin } = await loaded();
      plugin.setDevice({ ntfy: { ...plugin.device.ntfy, enabled: true } });
      Setting.all = [];
      tabOf(plugin).display();
      await (last("Access token").components[0] as TextComponent).change("tk_x");
      await (last("Server").components[0] as TextComponent).change("HTTP://192.168.1.20:8080");
      expect(last("Access token").desc).toContain("unencrypted");
      plugin.unload();
    });
  });

  it("tells the user at start-up when no device publishes (#26)", async () => {
    Notice.messages = [];
    const { plugin } = await loaded();
    await settle(20);
    expect(Notice.messages).toContain("No device publishes scheduled posts yet. Publish from this device");
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

  it("still starts the loop and the banner when the startup reconcile throws (fix round 2)", async () => {
    const app = new App();
    let ready: (() => Promise<void>) | undefined;
    app.workspace.onLayoutReady = (cb) => {
      ready = cb as () => Promise<void>;
    };
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    vi.spyOn(plugin.scheduler, "reconcile").mockRejectedValueOnce(new Error("Startup check broke"));
    const start = vi.spyOn(plugin.scheduler, "start");
    const banner = vi.spyOn(plugin.uiContext().publish, "overdueBanner");
    Notice.messages = [];
    await ready!();
    expect(Notice.messages).toContain("Startup check broke");
    expect(start).toHaveBeenCalledOnce();
    expect(banner).toHaveBeenCalledOnce();
    // `started` is set: a later claim runs its own reconcile.
    const became = vi.spyOn(plugin.scheduler, "becamePublisher");
    await plugin.publisher.claim();
    expect(became).toHaveBeenCalledOnce();
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

describe("phone reminder links (#70)", () => {
  it("opens the assisted flow from a phone reminder link once the index is ready (#70, review focus 5)", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00" }, "Hi");
    await settle();
    let ready: (() => unknown) | undefined;
    app.workspace.onLayoutReady = (cb) => {
      ready = cb;
    };
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.updateSettings({ channels: [{ id: "bs/you", platform: "bluesky", name: "@you", kind: "account", avatarColor: "#c9c3b8", method: "assisted" }] as never });
    Modal.opened = [];
    const handler = (plugin as unknown as { protocolHandlers: Map<string, (p: Record<string, string>) => Promise<void>> }).protocolHandlers.get("osmm-post")!;
    const opening = handler({ action: "osmm-post", vault: "Test Vault", path: P, channel: "bs/you" });
    await settle(20);
    expect(Modal.opened).toEqual([]);
    await ready?.();
    await opening;
    expect(Modal.opened.at(-1)?.titleEl.textContent).toBe("Post");
    plugin.unload();
  });

  it("does not reopen a post that is already out from a phone link", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "published", deliveries: { "bs/you": { status: "published" } } }, "Hi");
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    Modal.opened = [];
    Notice.messages = [];
    await plugin.openFromLink({ path: P, channel: "bs/you", step: "3" });
    await plugin.openFromLink({ path: P, channel: "bs/you" });
    await plugin.openFromLink({ path: "Social/Posts/Gone.md", channel: "bs/you" });
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual(["bs/you is already done for this post.", "Nothing left to post for this note.", "That post is no longer in this vault."]);
    expect(plugin.index.getVariant(P)?.deliveries["bs/you"]?.status).toBe("published");
    plugin.unload();
  });

  it("refuses a channel that is not on the note or whose delivery entry is unreadable, on both steps (M3 P7)", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(
      app as never,
      P,
      { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00", deliveries: { "bs/you": { status: "Handed-Over" } } },
      "Hi",
    );
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    Modal.opened = [];
    Notice.messages = [];
    const before = await app.vault.read(app.vault.getFileByPath(P)!);
    for (const channel of ["bs/you", "li/other"]) {
      await plugin.openFromLink({ path: P, channel, step: "3" });
      await plugin.openFromLink({ path: P, channel });
    }
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual([
      "bs/you can't be posted from this link: its delivery entry in the note can't be read. Fix it in the note first.",
      "bs/you can't be posted from this link: its delivery entry in the note can't be read. Fix it in the note first.",
      "li/other is not a channel of this post.",
      "li/other is not a channel of this post.",
    ]);
    expect(await app.vault.read(app.vault.getFileByPath(P)!)).toBe(before);
    plugin.unload();
  });

  it("refuses to open a note Claude wrote while Obsidian was closed from a phone link (#84 fix round 1, m3)", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(
      app as never,
      P,
      { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00", review: "claude", deliveries: { "bs/you": { status: "scheduled" } } },
      "Hi",
    );
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    Modal.opened = [];
    Notice.messages = [];
    const before = await app.vault.read(app.vault.getFileByPath(P)!);
    await plugin.openFromLink({ path: P, channel: "bs/you", step: "3" });
    await plugin.openFromLink({ path: P, channel: "bs/you" });
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual(["Approve it first in Written by Claude.", "Approve it first in Written by Claude."]);
    expect(await app.vault.read(app.vault.getFileByPath(P)!)).toBe(before);
    plugin.unload();
  });

  it("refuses Done while the delivery is being published", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00", deliveries: { "bs/you": { status: "publishing" } } }, "Hi");
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    Modal.opened = [];
    Notice.messages = [];
    await plugin.openFromLink({ path: P, channel: "bs/you", step: "3" });
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual(["bs/you is being published right now."]);
    plugin.unload();
  });

  it("reports a phone link that fails instead of leaving the rejection unhandled", async () => {
    const { plugin } = await loaded();
    vi.spyOn(plugin, "openFromLink").mockRejectedValue(new Error("boom"));
    Notice.messages = [];
    const handler = (plugin as unknown as { protocolHandlers: Map<string, (p: Record<string, string>) => unknown> }).protocolHandlers.get("osmm-post")!;
    await handler({ action: "osmm-post", path: "p.md", channel: "bs/you" });
    await settle();
    expect(Notice.messages).toEqual(["Couldn't open the post from the phone link: boom"]);
    plugin.unload();
  });

  it("re-validates the exact text before opening the flow (M2b P3)", async () => {
    const app = new App();
    const P = "Social/Posts/P.md";
    await writeNote(app as never, P, { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: "2026-12-01T09:00:00+01:00" }, "x".repeat(400));
    await settle();
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await plugin.ready;
    await plugin.updateSettings({ channels: [{ id: "bs/you", platform: "bluesky", name: "@you", kind: "account", avatarColor: "#c9c3b8", method: "assisted" }] as never });
    Modal.opened = [];
    Notice.messages = [];
    await plugin.openFromLink({ path: P, channel: "bs/you" });
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toHaveLength(1);
    plugin.unload();
  });

  it("gives up waiting for a cold start after a bound, and ignores links without a path or channel", async () => {
    const app = new App();
    app.workspace.onLayoutReady = () => undefined;
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    Modal.opened = [];
    Notice.messages = [];
    await plugin.openFromLink({ path: "Social/Posts/P.md" });
    await plugin.openFromLink({ channel: "bs/you" });
    expect(Notice.messages).toEqual([]);
    vi.useFakeTimers();
    try {
      const opening = plugin.openFromLink({ path: "Social/Posts/P.md", channel: "bs/you" });
      await vi.advanceTimersByTimeAsync(LINK_READY_TIMEOUT_MS);
      await opening;
    } finally {
      vi.useRealTimers();
    }
    expect(Modal.opened).toEqual([]);
    expect(Notice.messages).toEqual(["Social Planner is still starting. Tap the reminder again in a moment."]);
    plugin.unload();
  });
});

describe("Claude Code server (#73)", () => {
  it("stays off by default on a desktop", async () => {
    const { plugin } = await loaded();
    expect(plugin.device.mcp).toEqual({ enabled: false, port: 27150 });
    expect(get(plugin.mcp.status)).toEqual({ state: "off" });
    plugin.unload();
  });

  it("is unavailable on phones and the plugin still loads", async () => {
    setPlatform("iphone");
    const { plugin } = await loaded();
    await plugin.mcp.apply();
    expect(get(plugin.mcp.status)).toEqual({ state: "unavailable" });
    plugin.unload();
  });

  it("starts at load when it was on, and releases the port on unload (review focus 4)", async () => {
    const port = await freePort();
    const app = new App();
    app.saveLocalStorage("osmm-device", { mcp: { enabled: true, port } });
    const plugin = new OsmmPlugin(app as never, manifest);
    await plugin.load();
    await settle();
    await plugin.mcp.apply();
    expect(get(plugin.mcp.status)).toEqual({ state: "on", port });
    plugin.unload();
    await plugin.mcp.apply();
    expect(await portIsFree(port)).toBe(true);
  });

  it("asks in an Obsidian modal before Claude publishes, and unload answers no (#77)", async () => {
    const { plugin } = await loaded();
    expect(plugin.tools.names()).toEqual(expect.arrayContaining(["publish_now", "push_update"]));
    const before = Modal.opened.length;
    const req = { action: "publish" as const, title: "T", path: "p.md", platformLabel: "Telegram", channels: [{ id: "tg/x", name: "X", how: "posts through the API now", status: "scheduled" }], text: "hi", items: ["hi"], details: [] };
    const answer = plugin.approvals.request(req);
    expect(Modal.opened.length).toBe(before + 1);
    expect(Modal.opened.at(-1)!.titleEl.textContent).toBe("Claude wants to publish");
    plugin.unload();
    expect(await answer).toEqual({ approved: false, reason: CLOSED });
    expect(Modal.opened.at(-1)!.isOpen).toBe(false);
    expect(await plugin.approvals.request(req)).toEqual({ approved: false, reason: CLOSED });
  });

  it("sets up Claude Code from the settings without the token leaving secret storage (#78)", async () => {
    const { app, plugin } = await loaded();
    const port = await freePort();
    plugin.setDevice({ mcp: { enabled: false, port } });
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    await (last("MCP server on this device").components[0] as ToggleComponent).toggle(true);
    expect(get(plugin.mcp.status)).toEqual({ state: "on", port });
    expect(Setting.all.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Status", "Port", "Connect Claude Code", "Test connection", "Access token for Claude", "Publishing from Claude"]),
    );
    const token = plugin.mcp.token()!;
    expect(last("Connect Claude Code").desc).toContain('--header "Authorization: Bearer ••••"');
    expect(last("Connect Claude Code").desc).not.toContain(token);
    await (last("Connect Claude Code").components[0] as ButtonComponent).click();
    expect(browser.clipboard.at(-1)).toEqual({
      kind: "text",
      text: `claude mcp add --transport http --scope user --header "Authorization: Bearer ${token}" osmm http://127.0.0.1:${port}/mcp`,
    });
    await (last("Test connection").components[0] as ButtonComponent).click();
    expect(Notice.messages.at(-1)).toBe("The server answers. Claude Code can connect.");
    expect(JSON.stringify(await plugin.loadData())).not.toContain(token);
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toContain(token);
    plugin.unload();
  });

  it("rotates the token after a confirmation and validates the port (#73, #78)", async () => {
    const { plugin } = await loaded();
    const port = await freePort();
    plugin.setDevice({ mcp: { enabled: true, port } });
    await plugin.mcp.apply();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    const old = plugin.mcp.token();
    const clicked = (last("Access token for Claude").components[0] as ButtonComponent).click();
    [...Modal.opened.at(-1)!.contentEl.querySelectorAll("button")].find((b) => b.textContent === "New token")!.click();
    await clicked;
    expect(plugin.mcp.token()).not.toBe(old);
    await (last("Port").components[0] as TextComponent).change("80");
    await (last("Port").components[1] as ButtonComponent).click();
    expect(Notice.messages.at(-1)).toBe("Use a port between 1024 and 65535.");
    expect(plugin.device.mcp.port).toBe(port);
    plugin.unload();
  });

  it("lets a channel publish without asking only after a confirmation (#77)", async () => {
    const { plugin } = await loaded();
    await plugin.channels.upsertChannel({ id: "tg/event-x", platform: "telegram", name: "Event X channel", kind: "page", avatarColor: "#5cc6d6", method: "api" });
    plugin.setDevice({ mcp: { enabled: true, port: await freePort() } });
    await plugin.mcp.apply();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    Setting.all = [];
    tab.display();
    const policy = Setting.all.filter((s) => s.name === "Event X channel (Telegram)").at(-1)!.components[0] as DropdownComponent;
    expect(policy.value).toBe("ask");
    const changed = policy.change("allow");
    [...Modal.opened.at(-1)!.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Allow")!.click();
    await changed;
    expect(plugin.settings.publishWithoutAsking).toEqual(["tg/event-x"]);
    plugin.unload();
  });

  it("shows the setup command copy explains where the token ends up (#78, P9)", async () => {
    const { plugin } = await loaded();
    plugin.setDevice({ mcp: { enabled: true, port: await freePort() } });
    await plugin.mcp.apply();
    const tab = (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!;
    const last = (n: string) => Setting.all.filter((s) => s.name === n).at(-1)!;
    Setting.all = [];
    tab.display();
    await (last("Connect Claude Code").components[0] as ButtonComponent).click();
    expect(Notice.messages.at(-1)).toContain("Claude Code's");
    plugin.unload();
  });

  it("prunes publishWithoutAsking when a channel is deleted (Task 9 carry)", async () => {
    const { plugin } = await loaded();
    await plugin.channels.upsertChannel({ id: "tg/event-x", platform: "telegram", name: "Event X channel", kind: "page", avatarColor: "#5cc6d6", method: "api" });
    await plugin.updateSettings({ publishWithoutAsking: ["tg/event-x"] });
    expect(plugin.settings.publishWithoutAsking).toEqual(["tg/event-x"]);
    await plugin.channels.removeChannel("tg/event-x");
    expect(plugin.settings.publishWithoutAsking).toEqual([]);
    plugin.unload();
  });

  it("has no Claude Code section on phones", async () => {
    setPlatform("iphone");
    const { plugin } = await loaded();
    Setting.all = [];
    (plugin as unknown as { settingTabs: Array<{ display(): void }> }).settingTabs[0]!.display();
    expect(Setting.all.map((s) => s.name)).not.toContain("Claude Code");
    plugin.unload();
  });
});
