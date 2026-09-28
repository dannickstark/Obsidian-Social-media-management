import { describe, expect, it } from "vitest";
import { failureMessage, leadTime, openNoteUri, postUri, publishedMessage, reminderMessage, type ReminderContentDeps } from "../../../src/reminders/ntfy/content";
import type { ReminderItem } from "../../../src/reminders/reminders";

const AT = Date.UTC(2026, 9, 12, 16); // Mon 12 Oct 2026, 18:00 Berlin
const PATH = "Social/Event X/Event X – LinkedIn.md";
const item: ReminderItem = { key: `${PATH}#li/acme@${AT}:10`, path: PATH, channelId: "li/acme", at: AT, minutes: 10, title: "Event X is back" };
const deps = (target: string | null = "https://www.linkedin.com/feed/?shareActive=true&text=Hi"): ReminderContentDeps => ({
  vaultName: () => "My Vault",
  variant: () => ({ platform: "linkedin", displayTitle: "Event X is back" }),
  channelName: () => "Acme Studio",
  targetUrl: async () => target,
});
const COPY_OPEN = "obsidian://osmm-post?vault=My%20Vault&path=Social%2FEvent%20X%2FEvent%20X%20%E2%80%93%20LinkedIn.md&channel=li%2Facme";
const OPEN_NOTE = "obsidian://open?vault=My%20Vault&file=Social%2FEvent%20X%2FEvent%20X%20%E2%80%93%20LinkedIn.md";

describe("reminder pushes (#70, artboard 7)", () => {
  it("says when, where and what, and opens the pre-filled page when tapped", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    expect({ ...msg, actions: msg.actions!.slice(0, 2) }).toEqual({
      title: "In 10 min · LinkedIn",
      message: "Event X is back\nAcme Studio · 18:00",
      priority: 4,
      tags: ["osmm", "osmm-linkedin"],
      click: "https://www.linkedin.com/feed/?shareActive=true&text=Hi",
      actions: [
        { action: "view", label: "Copy & open", url: COPY_OPEN, clear: true },
        { action: "view", label: "Open note", url: OPEN_NOTE },
      ],
    });
  });

  it("snoozes by re-posting the same push 10 minutes later", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    const snooze = msg.actions![2]!;
    expect(snooze).toMatchObject({ action: "http", label: "Snooze 10 min", url: "https://ntfy.sh/", method: "POST", headers: { "Content-Type": "application/json" }, clear: true });
    expect(JSON.parse((snooze as { body: string }).body)).toEqual({
      topic: "osmm-abc",
      title: "In 10 min · LinkedIn",
      message: "Event X is back\nAcme Studio · 18:00",
      priority: 4,
      tags: ["osmm", "osmm-linkedin"],
      click: "https://www.linkedin.com/feed/?shareActive=true&text=Hi",
      actions: msg.actions!.slice(0, 2),
      delay: "10m",
    });
  });

  it("offers Done instead of Snooze with an access token, and never includes the token", async () => {
    const msg = await reminderMessage(item, deps(), { server: "https://push.example.org", topic: "osmm-abc", token: "tk_SECRET" });
    expect(msg.actions![2]).toEqual({ action: "view", label: "Done", url: `${COPY_OPEN}&step=3`, clear: true });
    expect(JSON.stringify(msg)).not.toContain("tk_SECRET");
  });

  it("falls back to the Copy & open link when the platform has no page to pre-fill", async () => {
    const msg = await reminderMessage({ ...item, minutes: 60 }, deps(null), { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    expect([msg.title, msg.priority, msg.click]).toEqual(["In 1 h · LinkedIn", 3, COPY_OPEN]);
  });

  it("links through Obsidian, resolved when tapped, when the server can't cancel outdated pushes (Task 8 ruling)", async () => {
    let asked = 0;
    const d: ReminderContentDeps = { ...deps(), targetUrl: async () => (asked++, "https://www.linkedin.com/feed/?shareActive=true&text=Old"), cancelSupported: () => false };
    const msg = await reminderMessage(item, d, { server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    expect(msg.click).toBe(COPY_OPEN);
    expect(JSON.parse((msg.actions![2] as { body: string }).body).click).toBe(COPY_OPEN);
    expect(JSON.stringify(msg)).not.toContain("text=Old");
    expect(asked).toBe(0);
  });

  it("formats lead times and links", () => {
    expect([leadTime(10), leadTime(60), leadTime(90), leadTime(120)]).toEqual(["10 min", "1 h", "90 min", "2 h"]);
    expect(postUri("V", "a b.md", "x/y", 3)).toBe("obsidian://osmm-post?vault=V&path=a%20b.md&channel=x%2Fy&step=3");
    expect(openNoteUri("V", "a b.md")).toBe("obsidian://open?vault=V&file=a%20b.md");
  });
});

describe("result pushes (#70, optional)", () => {
  const d = deps();
  it("alerts a failure with the note to fix", () => {
    expect(failureMessage({ path: PATH, channelId: "li/acme", kind: "needs_user", error: "Token expired" }, d)).toEqual({
      title: "Couldn't publish · LinkedIn",
      message: "Event X is back\nAcme Studio: Token expired",
      priority: 4,
      tags: ["osmm", "osmm-failed"],
      click: OPEN_NOTE,
      actions: [{ action: "view", label: "Open note", url: OPEN_NOTE }],
    });
  });

  it("confirms an automatic post with its link", () => {
    expect(publishedMessage({ path: PATH, channelId: "li/acme", url: "https://www.linkedin.com/feed/update/1" }, d)).toEqual({
      title: "Posted · LinkedIn",
      message: "Event X is back\nAcme Studio",
      priority: 2,
      tags: ["osmm", "osmm-published"],
      click: "https://www.linkedin.com/feed/update/1",
    });
  });
});
