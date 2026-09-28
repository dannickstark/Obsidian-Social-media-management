import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/model/dates";
import { dueReminders } from "../../src/reminders/reminders";
import { ReminderService } from "../../src/reminders/service";
import type { Notifier } from "../../src/reminders/notifier";
import type { ReminderItem } from "../../src/reminders/reminders";
import { makeCtx } from "../ui/ctx";
import { get } from "svelte/store";

const MIN = 60_000;
const AT = Date.UTC(2026, 9, 12, 16); // Mon 12 Oct 2026, 18:00 Berlin
const P = "Social/Posts/R.md";
const note = (extra: Record<string, unknown> = {}) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(AT), reminders: [60, 10, 0], ...extra },
  body: "Hi",
});

describe("dueReminders", () => {
  it.each([
    ["the 60-minute reminder between two ticks", AT - 60 * MIN - 30_000, AT - 60 * MIN + 30_000, [60]],
    ["the 10-minute reminder between two ticks", AT - 10 * MIN - 30_000, AT - 10 * MIN, [10]],
    ["nothing between reminders", AT - 30 * MIN, AT - 29 * MIN, []],
    ["a reminder just missed at start-up (within 5 minutes)", null, AT - 57 * MIN, [60]],
    ["no stale reminder at start-up", null, AT - 50 * MIN, []],
    ["nothing once the post time has passed", AT - 30_000, AT + 30_000, []],
  ])("%s", async (_name, previous, now, minutes) => {
    const c = await makeCtx({ notes: [note()] });
    const rows = c.ctx.actions.rows();
    expect(dueReminders(rows, now, previous, (r) => r.variant.reminders ?? null).map((i) => i.minutes)).toEqual(minutes);
  });

  it("keys each reminder by row, due time and offset", async () => {
    const c = await makeCtx({ notes: [note()] });
    expect(dueReminders(c.ctx.actions.rows(), AT - 60 * MIN, AT - 61 * MIN, () => [60])[0]).toEqual({
      key: `${P}#bs/you@${AT}:60`,
      path: P,
      channelId: "bs/you",
      at: AT,
      minutes: 60,
      title: "Hi",
    });
  });
});

describe("ReminderService", () => {
  it("reminds only for channels that won't post by themselves", async () => {
    const c = await makeCtx({ notes: [note({ reminders: undefined })] });
    const seen: ReminderItem[] = [];
    const service = new ReminderService({
      rows: () => c.ctx.actions.rows(),
      channels: c.ctx.channels,
      adapters: c.adapters,
      settings: () => get(c.settings),
      notifier: { reminder: (i: ReminderItem) => void seen.push(i) } as unknown as Notifier,
    });
    const row = c.ctx.actions.rows().find((r) => r.variant.path === P)!;
    expect(service.offsets(row)).toEqual([60, 10]);
    expect(service.tick(AT - 60 * MIN, AT - 61 * MIN).map((i) => i.minutes)).toEqual([60]);
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/x" }) });
    expect(service.offsets(c.ctx.actions.rows().find((r) => r.variant.path === P)!)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
