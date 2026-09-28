import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../fakes/obsidian";
import { browser, FakeNotification } from "../fakes/browser";
import { NotifiedLedger } from "../../src/reminders/ledger";
import { Notifier, type NotifierDeps } from "../../src/reminders/notifier";
import type { ReminderItem } from "../../src/reminders/reminders";
import { loadDeviceSettings, saveDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";

const item: ReminderItem = { key: "p.md#bs/you@1:10", path: "p.md", channelId: "bs/you", at: 1, minutes: 10, title: "Event X is back" };

function build(over: Partial<NotifierDeps> = {}, app = createApp()) {
  const opened: Array<[string, string[]]> = [];
  const composed: string[] = [];
  const timers: Array<() => void> = [];
  const notifier = new Notifier({
    ledger: new NotifiedLedger(app as never, () => 1_000),
    enabled: () => true,
    channelName: () => "@you.bsky.social",
    noteTitle: () => "Event X is back",
    openAssisted: (path, ids) => void opened.push([path, ids]),
    openComposer: (path) => void composed.push(path),
    setTimer: (fn) => void timers.push(fn),
    ...over,
  });
  return { notifier, opened, composed, timers, app };
}

const lastNoticeButton = (label: string) => [...Notice.last!.noticeEl.querySelectorAll("button")].find((b) => b.textContent === label)!;

beforeEach(() => {
  // jsdom doesn't implement window.focus(); the notifier calls it when a system notification is clicked.
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
});

describe("Notifier", () => {
  it("shows an in-app notice with Open & post and Snooze while Obsidian is focused", () => {
    const { notifier, opened } = build();
    notifier.reminder(item);
    expect(Notice.messages.at(-1)).toContain("In 10 min: Event X is back · Post to @you.bsky.social.");
    expect(browser.notifications).toEqual([]);
    lastNoticeButton("Open & post").click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
    expect(Notice.last!.hidden).toBe(true);
  });

  it("also raises a system notification when the window is in the background", () => {
    browser.focused = false;
    const { notifier, opened } = build();
    notifier.reminder(item);
    expect(browser.notifications.map((n) => [n.title, n.options.body])).toEqual([["In 10 min: Event X is back", "Post to @you.bsky.social."]]);
    browser.notifications[0]!.click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
  });

  it("asks for permission once instead of notifying when it hasn't been granted yet", () => {
    browser.focused = false;
    FakeNotification.permission = "default";
    build().notifier.reminder(item);
    expect(FakeNotification.requested).toBe(1);
    expect(browser.notifications).toEqual([]);
  });

  it("shows each reminder once per device, even after a restart (review focus 5)", () => {
    const app = createApp();
    const first = build({}, app);
    const count = Notice.messages.length;
    first.notifier.reminder(item);
    first.notifier.reminder(item);
    build({}, app).notifier.reminder(item);
    expect(Notice.messages.length).toBe(count + 1);
  });

  it("shows the reminder again after a snooze", () => {
    const { notifier, timers } = build();
    notifier.reminder(item);
    const count = Notice.messages.length;
    lastNoticeButton("Snooze 10 min").click();
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(Notice.messages.length).toBe(count + 1);
    expect(Notice.messages.at(-1)).toContain("In 10 min: Event X is back");
  });

  it("stays quiet when notifications are off on this device", () => {
    const { notifier } = build({ enabled: () => false });
    const count = Notice.messages.length;
    notifier.reminder(item);
    notifier.due("p.md", "bs/you");
    expect(Notice.messages.length).toBe(count);
  });

  it("doesn't record a reminder as shown when it arrives while notifications are off (fix round 1)", () => {
    const app = createApp();
    let enabled = false;
    const { notifier } = build({ enabled: () => enabled }, app);
    notifier.reminder(item);
    const count = Notice.messages.length;
    enabled = true;
    notifier.reminder(item);
    expect(Notice.messages.length).toBe(count + 1);
    expect(Notice.messages.at(-1)).toContain("In 10 min: Event X is back");
  });

  it("reports due posts and failures with their actions", () => {
    const { notifier, opened, composed } = build();
    notifier.due("p.md", "bs/you");
    expect(Notice.messages.at(-1)).toContain("Time to post: Event X is back · @you.bsky.social is waiting for you.");
    lastNoticeButton("Open & post").click();
    notifier.failed({ path: "p.md", channelId: "bs/you", kind: "needs_user", error: "Token expired" });
    expect(Notice.messages.at(-1)).toContain("Couldn't publish: Event X is back · @you.bsky.social: Token expired");
    lastNoticeButton("Fix").click();
    expect(opened).toEqual([["p.md", ["bs/you"]]]);
    expect(composed).toEqual(["p.md"]);
  });
});

describe("NotifiedLedger", () => {
  it("forgets entries after 14 days", () => {
    const app = createApp();
    let now = 0;
    const ledger = new NotifiedLedger(app as never, () => now);
    expect(ledger.add("a")).toBe(true);
    expect(ledger.add("a")).toBe(false);
    now = 15 * 86_400_000;
    ledger.add("b");
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("b")).toBe(true);
  });
});

describe("device notifications setting", () => {
  it("is on by default and persists per device", () => {
    const app = createApp();
    const device = loadDeviceSettings(app as never);
    expect(device.notifications).toBe(true);
    saveDeviceSettings(app as never, { ...device, notifications: false });
    expect(loadDeviceSettings(app as never).notifications).toBe(false);
  });
});

describe("Notifier timers", () => {
  it("snoozes with a real timer by default", () => {
    vi.useFakeTimers();
    try {
      const { notifier } = build({ setTimer: undefined });
      notifier.reminder({ ...item, key: "other" });
      const count = Notice.messages.length;
      lastNoticeButton("Snooze 10 min").click();
      vi.advanceTimersByTime(10 * 60_000);
      expect(Notice.messages.length).toBe(count + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
