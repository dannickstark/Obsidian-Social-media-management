import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { formatDateTime } from "../../src/model/dates";
import { decide, dueItems, GRACE_MS, type DueItem } from "../../src/scheduler/due";
import { Scheduler, type SchedulerDeps } from "../../src/scheduler/scheduler";
import { indexed } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const MIN = 60_000;
const A = "Social/Posts/A.md";
const B = "Social/Posts/B.md";
const note = (path: string, at: number, extra: Record<string, unknown> = {}) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "bluesky",
    channels: ["bs/you"],
    status: "scheduled",
    scheduled_at: formatDateTime(at),
    deliveries: { "bs/you": { status: "scheduled" } },
    ...extra,
  },
  body: "Hi",
});
const key = (path: string, at: number) => `${path}#bs/you@${at}`;

function build(c: TestCtx, over: Partial<SchedulerDeps> = {}) {
  const calls = { dispatched: [] as string[], overdue: [] as string[] };
  const warnings: string[] = [];
  const scheduler = new Scheduler({
    index: c.index,
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => true,
    autoPostLateMs: () => null,
    publish: {
      dispatch: async (i: DueItem) => void calls.dispatched.push(i.key),
      markOverdue: async (i: DueItem) => void calls.overdue.push(i.key),
      markCheckNeeded: async () => false,
      resolveCheck: async () => undefined,
    },
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { scheduler, calls, warnings };
}

describe("due items", () => {
  it("decides between posting now and the Overdue tray", () => {
    expect(decide({ late: GRACE_MS }, null)).toBe("dispatch");
    expect(decide({ late: GRACE_MS + 1 }, null)).toBe("overdue");
    expect(decide({ late: 20 * MIN }, 30 * MIN)).toBe("dispatch");
    expect(decide({ late: 40 * MIN }, 30 * MIN)).toBe("overdue");
  });

  it("lists scheduled deliveries whose time has come, with their stagger", async () => {
    const c = await makeCtx({ notes: [note(A, T, { platform: "linkedin", channels: ["li/me", "li/acme"], stagger_minutes: 15, deliveries: undefined })] });
    expect(dueItems(c.index.variants(), T + 16 * MIN, 15).map((i) => [i.channelId, i.late])).toEqual([
      ["li/me", 16 * MIN],
      ["li/acme", 1 * MIN],
    ]);
  });
});

describe("Scheduler", () => {
  it("dispatches a due delivery exactly once", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T - MIN });
    const { scheduler, calls } = build(c);
    await scheduler.tick();
    expect(calls.dispatched).toEqual([]);
    c.now.set(T + 10_000);
    expect((await scheduler.tick()).dispatched).toEqual([key(A, T)]);
    await scheduler.tick();
    c.now.set(T + 40_000);
    await scheduler.tick();
    expect(calls.dispatched).toEqual([key(A, T)]);
  });

  it("after a sleep, posts what just fell due and sends the rest to the Overdue tray (review focus 3)", async () => {
    const wake = T + 3 * 60 * MIN;
    const c = await makeCtx({ notes: [note(A, T), note(B, wake - MIN)], now: T - MIN });
    const { scheduler, calls } = build(c);
    await scheduler.tick();
    c.now.set(wake);
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(B, wake - MIN)], overdue: [key(A, T)] });
  });

  it("posts late items within the auto-post window when that setting is on", async () => {
    const c = await makeCtx({ notes: [note(A, T), note(B, T - 30 * MIN)], now: T + 20 * MIN });
    const { scheduler, calls } = build(c, { autoPostLateMs: () => 30 * MIN });
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(A, T)], overdue: [key(B, T - 30 * MIN)] });
  });

  it("stays passive when this device is not the publisher, but still ticks", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const ticks: Array<[number, number | null]> = [];
    const { scheduler, calls } = build(c, { isPublisher: () => false, onTick: (now, previous) => void ticks.push([now, previous]) });
    await scheduler.tick();
    c.now.set(T + 30_000);
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [], overdue: [] });
    expect(ticks).toEqual([
      [T, null],
      [T + 30_000, T],
    ]);
  });

  it("still dispatches due items in the same tick when onTick throws or rejects (fix round 1)", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const { scheduler, calls, warnings } = build(c, {
      onTick: () => {
        throw new Error("reminder boom");
      },
    });
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(A, T)], overdue: [] });
    expect(warnings).toEqual(["reminder boom"]);

    const c2 = await makeCtx({ notes: [note(B, T)], now: T });
    const { scheduler: scheduler2, calls: calls2, warnings: warnings2 } = build(c2, {
      onTick: async () => Promise.reject(new Error("reminder rejected")),
    });
    await scheduler2.tick();
    expect(calls2).toEqual({ dispatched: [key(B, T)], overdue: [] });
    expect(warnings2).toEqual(["reminder rejected"]);
  });

  it("never dispatches an unreadable entry and warns once (review focus 1)", async () => {
    const c = await makeCtx({ notes: [note(A, T, { deliveries: { "bs/you": { status: "Scheduled!" } } })], now: T });
    const { scheduler, calls, warnings } = build(c);
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [], overdue: [] });
    expect(warnings).toEqual(["A: the delivery status of bs/you can't be read, so it won't be published. Fix it in the note."]);
  });

  it("ticks every 30 seconds until stopped", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const set = vi.fn((fn: () => void, _ms: number) => {
      fn();
      return 7;
    });
    const clear = vi.fn();
    const { scheduler, calls } = build(c, { timers: { set, clear } });
    scheduler.start();
    scheduler.start();
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]![1]).toBe(30_000);
    await vi.waitFor(() => expect(calls.dispatched).toEqual([key(A, T)]));
    scheduler.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });
});

describe("dispatch through PublishActions", () => {
  it("assisted: the delivery waits for the user and a reminder goes out", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const due = vi.fn();
    c.ctx.publish.notifier = { due, failed: vi.fn() };
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "awaiting_you");
    expect(due).toHaveBeenCalledWith(A, "bs/you");
  });

  it("api: the orchestrator publishes it", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.status === "published");
    expect(c.index.getVariant(A)!.deliveries["bs/you"]?.url).toBe("https://bsky.app/profile/you/post/1");
  });

  it("late: the delivery becomes overdue", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T + 60 * MIN });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "overdue");
    expect(c.log.entries.map((e) => e.result)).toEqual(["overdue"]);
  });

  it("native without an adapter falls back to the assisted flow", async () => {
    const M = "Social/Posts/M.md";
    const c = await makeCtx({ notes: [{ ...note(M, T), frontmatter: { ...note(M, T).frontmatter, platform: "mastodon", channels: ["ma/you"], deliveries: undefined } }], now: T });
    const { scheduler } = build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.status === "awaiting_you");
  });
});
