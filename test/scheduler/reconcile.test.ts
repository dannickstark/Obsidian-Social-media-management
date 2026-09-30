import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { formatDateTime } from "../../src/model/dates";
import type { RemoteState } from "../../src/platforms/types";
import { reconcilePlan } from "../../src/scheduler/reconcile";
import { Scheduler } from "../../src/scheduler/scheduler";
import { autoPostLateMs, migrateSettings } from "../../src/settings/settings";
import { indexed, settle } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const MIN = 60_000;
const P = "Social/Posts/Tg.md";
const note = (path: string, at: number, delivery: Record<string, unknown>) => ({
  path,
  frontmatter: {
    type: "social-post",
    platform: "telegram",
    channels: ["tg/event-x"],
    status: "scheduled",
    scheduled_at: formatDateTime(at),
    deliveries: { "tg/event-x": delivery },
  },
  body: "Doors open",
});

function scheduler(c: TestCtx, isPublisher = true) {
  return new Scheduler({
    index: c.index,
    settings: () => get(c.settings),
    now: () => get(c.now),
    isPublisher: () => isPublisher,
    autoPostLateMs: () => autoPostLateMs(get(c.settings)),
    publish: c.ctx.publish,
    warn: () => undefined,
  });
}

async function withLookup(lookup: () => Promise<RemoteState | null>, now = T + 10 * MIN) {
  const c = await makeCtx({ notes: [note(P, T, { status: "publishing", at: formatDateTime(T) })], now });
  const publish = vi.fn(async () => ({ remoteId: "1", url: "https://t.me/eventx/1" }));
  c.adapters.register({ platform: "telegram", publish, lookup });
  return { c, publish };
}

describe("reconcilePlan", () => {
  it("marks stuck publishing, and sorts late items into dispatch or overdue", async () => {
    const c = await makeCtx({
      notes: [
        note("Social/Posts/Stuck.md", T, { status: "publishing" }),
        note("Social/Posts/Handing.md", T + 60 * MIN, { status: "handed_over", at: formatDateTime(T + 60 * MIN) }),
        note("Social/Posts/Handed.md", T + 60 * MIN, { status: "handed_over", remote_id: "7" }),
        note("Social/Posts/Late.md", T - 60 * MIN, { status: "scheduled" }),
        note("Social/Posts/Now.md", T - MIN, { status: "scheduled" }),
      ],
    });
    const plan = reconcilePlan(c.index.variants(), T, 15, null);
    expect(plan.map((a) => (a.kind === "check_needed" ? `${a.kind}:${a.path}` : `${a.kind}:${a.item.path}`)).sort()).toEqual([
      "check_needed:Social/Posts/Handing.md",
      "check_needed:Social/Posts/Stuck.md",
      "dispatch:Social/Posts/Now.md",
      "overdue:Social/Posts/Late.md",
    ]);
  });
});

describe("startup reconciliation (review focus 2)", () => {
  it("never retries a delivery found in publishing", async () => {
    const { c, publish } = await withLookup(async () => null);
    const s = scheduler(c);
    expect(await s.reconcile()).toEqual({ checkNeeded: 1, overdue: 0, dispatched: 0 });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
    await s.tick();
    c.now.set(T + 60 * MIN);
    await s.tick();
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toMatchObject({
      status: "check_needed",
      error: "Obsidian closed while this was being published. Check the platform, then mark it as published or not.",
    });
  });

  it("resolves with lookup() when the platform knows", async () => {
    const { c } = await withLookup(async () => ({ published: true, url: "https://t.me/eventx/5", remoteId: "5" }));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.status === "published");
    // Final review Minor 9: `at` is when it was found published, and the resolution is logged.
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]).toEqual({
      status: "published",
      at: T + 10 * MIN,
      url: "https://t.me/eventx/5",
      remoteId: "5",
    });
    expect(c.log.entries.at(-1)).toMatchObject({ path: P, channelId: "tg/event-x", result: "published", url: "https://t.me/eventx/5" });
  });

  it("marks it failed when lookup() finds nothing", async () => {
    const { c } = await withLookup(async () => ({ published: false }), T + 20 * MIN);
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.error).toBe("Not found on the platform after an interrupted publish.");
    expect(c.log.entries.at(-1)).toMatchObject({ path: P, channelId: "tg/event-x", result: "failed", error: "Not found on the platform after an interrupted publish." });
  });

  it("keeps a recent interrupted publish on check_needed when lookup() finds nothing (M3 P11)", async () => {
    const { c } = await withLookup(async () => ({ published: false }));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.error?.startsWith("Not found on the platform yet") === true);
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]!.status).toBe("check_needed");
    expect(c.log.entries.map((e) => e.result)).toEqual(["check_needed"]);
  });

  it("checks an interrupted hand-over at startup and returns it to handed_over when the platform has it (M5)", async () => {
    const M = "Social/Posts/Ma.md";
    const c = await makeCtx({
      notes: [{ path: M, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(T + 60 * MIN), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(T + 60 * MIN), remote_at: formatDateTime(T + 60 * MIN), digest: "d" } } }, body: "Hi" }],
      now: T,
    });
    const schedule = vi.fn(async () => ({ remoteId: "x" }));
    c.adapters.register({ platform: "mastodon", schedule, lookup: async () => ({ published: false, remoteId: "3221", scheduledAt: T + 60 * MIN }) });
    expect(await scheduler(c).reconcile()).toMatchObject({ checkNeeded: 1 });
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.remoteId === "3221");
    expect(c.index.getVariant(M)!.deliveries["ma/you"]).toMatchObject({ status: "handed_over", remoteAt: T + 60 * MIN });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("leaves an interrupted hand-over the platform doesn't have to the user", async () => {
    const M = "Social/Posts/Ma.md";
    const c = await makeCtx({
      notes: [{ path: M, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(T + 60 * MIN), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(T + 60 * MIN), remote_at: formatDateTime(T + 60 * MIN), digest: "d" } } }, body: "Hi" }],
      now: T + 60 * MIN,
    });
    c.adapters.register({ platform: "mastodon", schedule: async () => ({ remoteId: "x" }), lookup: async () => ({ published: false }) });
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(M)?.deliveries["ma/you"]?.error?.startsWith("Not found in the platform's scheduled posts") === true);
    expect(c.index.getVariant(M)!.deliveries["ma/you"]!.status).toBe("check_needed");
  });

  it("leaves it for the user when lookup() fails", async () => {
    const { c } = await withLookup(async () => Promise.reject(new Error("offline")));
    await scheduler(c).reconcile();
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
  });

  it("sends past-due items to the Overdue tray, or posts them within the late window", async () => {
    const late = note(P, T - 40 * MIN, { status: "scheduled" });
    const c = await makeCtx({ notes: [late], now: T });
    expect(await scheduler(c).reconcile()).toEqual({ checkNeeded: 0, overdue: 1, dispatched: 0 });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "overdue");

    const c2 = await makeCtx({ notes: [late], now: T });
    c2.settings.update((s) => ({ ...s, autoPostLate: true, autoPostLateMinutes: 60 }));
    expect(await scheduler(c2).reconcile()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 1 });
    await indexed(c2.index, () => c2.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "awaiting_you");
  });

  it("does not hold the gate while a lookup hangs: the next tick and its reminders run (fix round 2)", async () => {
    const lookup = vi.fn((): Promise<RemoteState | null> => new Promise(() => undefined));
    const { c } = await withLookup(lookup);
    const onTick = vi.fn();
    const s = new Scheduler({
      index: c.index,
      settings: () => get(c.settings),
      now: () => get(c.now),
      isPublisher: () => true,
      autoPostLateMs: () => null,
      publish: c.ctx.publish,
      onTick,
      warn: () => undefined,
    });
    const reconciled = await Promise.race([s.reconcile(), settle(200).then(() => "hung" as const)]);
    expect(reconciled).toEqual({ checkNeeded: 1, overdue: 0, dispatched: 0 });
    await indexed(c.index, () => c.index.getVariant(P)?.deliveries["tg/event-x"]?.status === "check_needed");
    await s.tick();
    expect(onTick).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("does nothing on a device that is not the publisher", async () => {
    const { c } = await withLookup(async () => null);
    expect(await scheduler(c, false).reconcile()).toEqual({ checkNeeded: 0, overdue: 0, dispatched: 0 });
    expect(c.index.getVariant(P)!.deliveries["tg/event-x"]?.status).toBe("publishing");
  });
});

describe("late auto-post setting", () => {
  it("is off by default with a 15-minute window", () => {
    const s = migrateSettings({});
    expect([s.autoPostLate, s.autoPostLateMinutes, autoPostLateMs(s)]).toEqual([false, 15, null]);
    const on = migrateSettings({ autoPostLate: true, autoPostLateMinutes: 30 });
    expect(autoPostLateMs(on)).toBe(30 * MIN);
    expect(migrateSettings({ autoPostLate: "yes", autoPostLateMinutes: 999 })).toMatchObject({ autoPostLate: false, autoPostLateMinutes: 15 });
  });
});
