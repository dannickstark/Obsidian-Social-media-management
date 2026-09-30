import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { formatDateTime } from "../../src/model/dates";
import { decide, dueItems, GRACE_MS, type DueItem } from "../../src/scheduler/due";
import { Scheduler, type SchedulerDeps } from "../../src/scheduler/scheduler";
import { indexed, settle } from "../helpers";
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

/** A scheduler past its startup reconcile (ticks before it are no-ops), run as a non-publisher so it does nothing. */
async function build(c: TestCtx, over: Partial<SchedulerDeps> = {}) {
  const calls = { dispatched: [] as string[], overdue: [] as string[] };
  const warnings: string[] = [];
  let reconciled = false;
  const publisher = over.isPublisher ?? (() => true);
  const scheduler = new Scheduler({
    index: c.index,
    settings: () => get(c.settings),
    now: () => get(c.now),
    autoPostLateMs: () => null,
    publish: {
      dispatch: async (i: DueItem) => void calls.dispatched.push(i.key),
      markOverdue: async (i: DueItem) => void calls.overdue.push(i.key),
      markCheckNeeded: async () => false,
      resolveCheck: async () => undefined,
    },
    warn: (m) => warnings.push(m),
    ...over,
    isPublisher: () => reconciled && publisher(),
  });
  await scheduler.reconcile();
  reconciled = true;
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
    const { scheduler, calls } = await build(c);
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
    const { scheduler, calls } = await build(c);
    await scheduler.tick();
    c.now.set(wake);
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(B, wake - MIN)], overdue: [key(A, T)] });
  });

  it("posts late items within the auto-post window when that setting is on", async () => {
    const c = await makeCtx({ notes: [note(A, T), note(B, T - 30 * MIN)], now: T + 20 * MIN });
    const { scheduler, calls } = await build(c, { autoPostLateMs: () => 30 * MIN });
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(A, T)], overdue: [key(B, T - 30 * MIN)] });
  });

  it("stays passive when this device is not the publisher, but still ticks", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const ticks: Array<[number, number | null]> = [];
    const { scheduler, calls } = await build(c, { isPublisher: () => false, onTick: (now, previous) => void ticks.push([now, previous]) });
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
    const { scheduler, calls, warnings } = await build(c, {
      onTick: () => {
        throw new Error("reminder boom");
      },
    });
    await scheduler.tick();
    expect(calls).toEqual({ dispatched: [key(A, T)], overdue: [] });
    expect(warnings).toEqual(["reminder boom"]);

    const c2 = await makeCtx({ notes: [note(B, T)], now: T });
    const { scheduler: scheduler2, calls: calls2, warnings: warnings2 } = await build(c2, {
      onTick: async () => Promise.reject(new Error("reminder rejected")),
    });
    await scheduler2.tick();
    expect(calls2).toEqual({ dispatched: [key(B, T)], overdue: [] });
    expect(warnings2).toEqual(["reminder rejected"]);
  });

  it("never dispatches an unreadable entry and warns once (review focus 1)", async () => {
    const c = await makeCtx({ notes: [note(A, T, { deliveries: { "bs/you": { status: "Scheduled!" } } })], now: T });
    const { scheduler, calls, warnings } = await build(c);
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
    const { scheduler, calls } = await build(c, { timers: { set, clear } });
    scheduler.start();
    scheduler.start();
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]![1]).toBe(30_000);
    await vi.waitFor(() => expect(calls.dispatched).toEqual([key(A, T)]));
    scheduler.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });
});

describe("background hand-over (M5)", () => {
  it("starts the background pass after the due items, on the publisher only", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const order: string[] = [];
    const background = vi.fn(() => void order.push("background"));
    let publisher = true;
    const port = {
      dispatch: async () => void order.push("dispatch"),
      markOverdue: async () => undefined,
      markCheckNeeded: async () => false,
      resolveCheck: async () => undefined,
      background,
    };
    const { scheduler } = await build(c, { publish: port, isPublisher: () => publisher });
    await scheduler.tick();
    expect(order).toEqual(["dispatch", "background"]);
    expect(background).toHaveBeenCalledWith(T);
    publisher = false;
    await scheduler.tick();
    expect(background).toHaveBeenCalledOnce();
  });
});

describe("Scheduler before the startup reconcile (final review Important 4)", () => {
  it("ignores ticks until reconcile has run", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const onTick = vi.fn();
    const dispatch = vi.fn(async () => undefined);
    const scheduler = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => true,
      autoPostLateMs: () => null,
      publish: { dispatch, markOverdue: async () => undefined, markCheckNeeded: async () => false, resolveCheck: async () => undefined },
      onTick,
      warn: () => undefined,
    });
    expect(await scheduler.tick()).toEqual({ dispatched: [], overdue: [] });
    expect(onTick).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await scheduler.reconcile()).toMatchObject({ dispatched: 1 });
    await scheduler.tick();
    expect(onTick).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe("dispatch through PublishActions", () => {
  it("assisted: the delivery waits for the user and a reminder goes out", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    const due = vi.fn();
    c.ctx.publish.notifier = { due, failed: vi.fn() };
    const { scheduler } = await build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "awaiting_you");
    expect(due).toHaveBeenCalledWith(A, "bs/you");
  });

  it("api: the orchestrator publishes it", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    c.adapters.register({ platform: "bluesky", publish: async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }) });
    const { scheduler } = await build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.status === "published");
    expect(c.index.getVariant(A)!.deliveries["bs/you"]?.url).toBe("https://bsky.app/profile/you/post/1");
  });

  it("api: re-validates the saved post at send time and leaves invalid content scheduled", async () => {
    const invalid = { ...note(A, T), body: "x".repeat(301) };
    const c = await makeCtx({ notes: [invalid], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    const publish = vi.fn(async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }));
    const failed = vi.fn();
    c.adapters.register({ platform: "bluesky", publish });
    c.ctx.publish.notifier = { due: vi.fn(), failed };
    const { scheduler } = await build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(publish).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ path: A, channelId: "bs/you", kind: "invalid_content" }));
    expect(c.index.getVariant(A)!.deliveries["bs/you"]?.status).toBe("scheduled");
  });

  it("late: the delivery becomes overdue", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T + 60 * MIN });
    const { scheduler } = await build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "overdue");
    expect(c.log.entries.map((e) => e.result)).toEqual(["overdue"]);
  });

  it("native without an adapter falls back to the assisted flow", async () => {
    const M = "Social/Posts/M.md";
    const c = await makeCtx({ notes: [{ ...note(M, T), frontmatter: { ...note(M, T).frontmatter, platform: "mastodon", channels: ["ma/you"], deliveries: undefined } }], now: T });
    const { scheduler } = await build(c, { publish: c.ctx.publish });
    await scheduler.tick();
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.status === "awaiting_you");
  });
});

describe("Scheduler when the publisher role changes (M3 P2)", () => {
  it("reconciles before any dispatch when this device becomes the publisher mid-session", async () => {
    const S = "Social/Posts/S.md";
    const c = await makeCtx({ notes: [note(S, T - 5 * MIN, { deliveries: { "bs/you": { status: "publishing", at: formatDateTime(T - 5 * MIN) } } }), note(A, T)], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    const publish = vi.fn(async () => ({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }));
    c.adapters.register({ platform: "bluesky", publish });
    let publisher = false;
    const scheduler = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => publisher,
      autoPostLateMs: () => null,
      publish: c.ctx.publish,
      warn: () => undefined,
    });
    // Start-up as a non-publisher: the reconcile does nothing but opens the ready gate.
    expect(await scheduler.reconcile()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 0 });
    publisher = true;
    const [ticked, summary] = await Promise.all([scheduler.tick(), scheduler.becamePublisher()]);
    expect(ticked).toEqual({ dispatched: [], overdue: [] });
    expect(summary).toEqual({ checkNeeded: 1, overdue: 0, dispatched: 1 });
    await indexed(c.index, () => c.index.getVariant(S)?.deliveries["bs/you"]?.status === "check_needed" && c.index.getVariant(A)?.status === "published");
    await scheduler.tick();
    c.now.set(T + 60 * MIN);
    await scheduler.tick();
    expect(publish).toHaveBeenCalledOnce();
    expect(c.index.getVariant(S)!.deliveries["bs/you"]?.status).toBe("check_needed");
  });

  it("stops dispatching as soon as the role is lost mid-loop, in tick and in reconcile", async () => {
    for (const via of ["tick", "reconcile"] as const) {
      const c = await makeCtx({ notes: [note(A, T), note(B, T)], now: T });
      let publisher = via === "reconcile";
      const dispatched: string[] = [];
      const scheduler = new Scheduler({
        index: c.index,
        settings: () => get(c.settings),
        now: () => get(c.now),
        isPublisher: () => publisher,
        autoPostLateMs: () => null,
        publish: {
          dispatch: async (i: DueItem) => {
            dispatched.push(i.key);
            publisher = false; // the takeover by another device synced in meanwhile
          },
          markOverdue: async () => undefined,
          markCheckNeeded: async () => false,
          resolveCheck: async () => undefined,
        },
        warn: () => undefined,
      });
      await scheduler.reconcile();
      if (via === "tick") {
        publisher = true;
        await scheduler.tick();
      }
      expect(dispatched).toHaveLength(1);
      // The skipped item was not consumed: it runs once the role comes back.
      publisher = true;
      await scheduler.tick();
      expect(dispatched.sort()).toEqual([key(A, T), key(B, T)]);
    }
  });
});

describe("Scheduler when the role flips on, off and on again (Task 2 follow-up)", () => {
  it("keeps the gate closed until the latest reconcile is done, and dispatches each item once", async () => {
    const S = "Social/Posts/S.md";
    const c = await makeCtx({ notes: [note(S, T - 5 * MIN, { deliveries: { "bs/you": { status: "publishing" } } }), note(A, T), note(B, T)], now: T });
    const gates: Array<() => void> = [];
    const dispatched: string[] = [];
    let publisher = false;
    const scheduler = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => publisher,
      autoPostLateMs: () => null,
      publish: {
        dispatch: async (i: DueItem) => void dispatched.push(i.key),
        markOverdue: async () => undefined,
        // Each reconcile blocks on its check until the test releases it; only the first one wins the write.
        markCheckNeeded: (): Promise<boolean> =>
          new Promise((resolve) => {
            const first = gates.length === 0;
            gates.push(() => resolve(first));
          }),
        resolveCheck: async () => undefined,
      },
      warn: () => undefined,
    });
    await scheduler.reconcile();
    publisher = true;
    const first = scheduler.becamePublisher();
    await settle();
    publisher = false;
    publisher = true;
    const second = scheduler.becamePublisher();
    await settle();
    expect(gates).toHaveLength(2);
    gates[0]!();
    expect(await first).toEqual({ checkNeeded: 1, overdue: 0, dispatched: 0 });
    // The superseded reconcile must not reopen the gate while the latest one still runs.
    expect(await scheduler.tick()).toEqual({ dispatched: [], overdue: [] });
    expect(dispatched).toEqual([]);
    gates[1]!();
    expect(await second).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 2 });
    await scheduler.tick();
    expect(dispatched.sort()).toEqual([key(A, T), key(B, T)]);
  });

  it("stops a tick's loop when a new reconcile starts mid-tick", async () => {
    const S = "Social/Posts/S.md";
    // The stuck entry makes the new reconcile await its check before it claims B.
    const c = await makeCtx({ notes: [note(S, T - 5 * MIN, { deliveries: { "bs/you": { status: "publishing" } } }), note(A, T), note(B, T)], now: T });
    const dispatched: string[] = [];
    let reconciling: Promise<unknown> | undefined;
    let publisher = true;
    const scheduler: Scheduler = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => publisher,
      autoPostLateMs: () => null,
      publish: {
        dispatch: async (i: DueItem) => {
          dispatched.push(i.key);
          if (!reconciling) {
            // The role flips off and on during the tick: a new reconcile takes over the rest.
            publisher = false;
            publisher = true;
            reconciling = scheduler.becamePublisher();
          }
        },
        markOverdue: async () => undefined,
        markCheckNeeded: async () => (await settle(), false),
        resolveCheck: async () => undefined,
      },
      warn: () => undefined,
    });
    publisher = false;
    await scheduler.reconcile();
    publisher = true;
    expect((await scheduler.tick()).dispatched).toHaveLength(1);
    await reconciling;
    expect(dispatched.sort()).toEqual([key(A, T), key(B, T)]);
  });
});

describe("an in-flight background publish (fix round 2)", () => {
  it("is left to its own run when a new reconcile starts, and settles published", async () => {
    const c = await makeCtx({ notes: [note(A, T)], now: T });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("bs/you")!, method: "api" });
    let release: () => void = () => undefined;
    const publish = vi.fn(() => new Promise<{ remoteId: string; url: string }>((resolve) => (release = () => resolve({ remoteId: "1", url: "https://bsky.app/profile/you/post/1" }))));
    const lookup = vi.fn(async () => ({ published: false }));
    c.adapters.register({ platform: "bluesky", publish, lookup });
    const seen = new Set<string>();
    c.index.onChange(() => {
      const status = c.index.getVariant(A)?.deliveries["bs/you"]?.status;
      if (status) seen.add(status);
    });
    let publisher = true;
    const scheduler = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => publisher,
      autoPostLateMs: () => null,
      publish: c.ctx.publish,
      warn: () => undefined,
    });
    expect(await scheduler.reconcile()).toMatchObject({ dispatched: 1 });
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "publishing");
    expect(c.ctx.publish.isInFlight(A, "bs/you")).toBe(true);
    expect(await c.ctx.publish.markCheckNeeded(A, "bs/you")).toBe(false);
    // The role flips off and on while the request is out: the new reconcile must not treat it as stuck.
    publisher = false;
    publisher = true;
    expect(await scheduler.becamePublisher()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 0 });
    release();
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "published");
    expect(seen.has("check_needed")).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });
});
