import { describe, expect, it, vi } from "vitest";
import { App } from "../../fakes/obsidian";
import { formatDateTime } from "../../../src/model/dates";
import { BookingLedger } from "../../../src/reminders/ntfy/bookings";
import { BOOKING_WINDOW_MS, NtfyBooker, RETRY_MS, WITHDRAW_WAIT_MS, type BookerDeps } from "../../../src/reminders/ntfy/booker";
import { NtfyError, type NtfyMessage } from "../../../src/reminders/ntfy/client";
import { PublisherService } from "../../../src/settings/publisher";
import { migrateSettings } from "../../../src/settings/settings";
import { indexed, settle, writeNote } from "../../helpers";
import { makeCtx, type TestCtx } from "../../ui/ctx";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const A = "Social/Posts/A.md";
const B = "Social/Posts/B.md";
const fm = (at: number, extra: Record<string, unknown> = {}) => ({
  type: "social-post",
  platform: "bluesky",
  channels: ["bs/you"],
  status: "scheduled",
  scheduled_at: formatDateTime(at),
  reminders: [60, 10],
  ...extra,
});
const key = (path: string, at: number, minutes: number) => `${path}#bs/you@${at}:${minutes}`;

function fakeClient(opts: { cancel?: "cancelled" | "unsupported" } = {}) {
  const sent: NtfyMessage[] = [];
  const cancelled: string[] = [];
  let calls = 0;
  let fail: Error | null = null;
  let cancelFail: Error | null = null;
  let gate: Promise<void> | null = null;
  let onPublish: () => void = () => {};
  return {
    sent,
    cancelled,
    calls: () => calls,
    failWith: (e: Error | null) => void (fail = e),
    failCancelWith: (e: Error | null) => void (cancelFail = e),
    /** Holds the next publishes until the returned function is called. */
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    afterPublish: (f: () => void) => void (onPublish = f),
    client: {
      publish: async (m: NtfyMessage) => {
        calls++;
        if (gate) await gate;
        if (fail) throw fail;
        sent.push(m);
        onPublish();
        return { id: `m${sent.length}`, at: m.at ?? 0 };
      },
      cancel: async (id: string) => {
        if (cancelFail) throw cancelFail;
        cancelled.push(id);
        return opts.cancel ?? ("cancelled" as const);
      },
    },
  };
}

function booker(c: TestCtx, fake: ReturnType<typeof fakeClient>, now: { t: number }, over: Partial<BookerDeps> = {}, app: App = c.app) {
  const warnings: string[] = [];
  const b = new NtfyBooker({
    rows: () => c.ctx.actions.rows(),
    offsets: (row) => row.variant.reminders ?? null,
    isPublisher: () => true,
    enabled: () => true,
    client: fake.client,
    ledger: new BookingLedger(app as never),
    compose: async (item) => ({ title: `In ${item.minutes} min`, message: item.title }),
    now: () => now.t,
    warn: (m) => void warnings.push(m),
    ...over,
  });
  return { b, warnings };
}

describe("NtfyBooker (#69, fake clock)", () => {
  it("books every reminder of the next 72 hours once, at its time", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }, { path: B, frontmatter: fm(T0 + 100 * HOUR), body: "B" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    expect((await b.sync()).booked).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    expect(fake.sent.map((m) => m.at)).toEqual([T0 + 9 * HOUR, T0 + 10 * HOUR - 10 * MIN]);
    now.t += 30_000;
    expect((await b.sync()).booked).toEqual([]);
    expect(fake.sent).toHaveLength(2);
  });

  it("books nothing beyond the window (ntfy.sh keeps delayed pushes at most 3 days)", async () => {
    const edge = T0 + BOOKING_WINDOW_MS + 60 * MIN;
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(edge, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    expect((await b.sync()).booked).toEqual([key(A, edge, 60)]);
    const late = await makeCtx({ notes: [{ path: A, frontmatter: fm(edge + MIN, { reminders: [60] }), body: "A" }] });
    expect((await booker(late, fakeClient(), { t: T0 }).b.sync()).booked).toEqual([]);
  });

  it("rebooks a rescheduled post and cancels the old pushes (review focus 1)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 12 * HOUR), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 12 * HOUR);
    const r = await b.sync();
    expect(r.cancelled).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    expect(r.booked).toEqual([key(A, T0 + 12 * HOUR, 60), key(A, T0 + 12 * HOUR, 10)]);
    expect(fake.cancelled).toEqual(["m1", "m2"]);
    expect(new BookingLedger(c.app as never).all().map((x) => x.key)).toEqual(r.booked);
  });

  it("leaves the old push alone when the server can't cancel, and still books the new time", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 11 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 11 * HOUR);
    const r = await b.sync();
    expect([r.leftStale, r.booked]).toEqual([[key(A, T0 + 10 * HOUR, 60)], [key(A, T0 + 11 * HOUR, 60)]]);
    // The old push still arrives: its entry stays, marked stale, until its time has passed.
    expect(new BookingLedger(c.app as never).all().map((x) => [x.key, x.stale === true])).toEqual([
      [key(A, T0 + 10 * HOUR, 60), true],
      [key(A, T0 + 11 * HOUR, 60), false],
    ]);
    expect(b.cancelSupported()).toBe(false);
  });

  it("cancels pushes for a post published or skipped early", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60], status: "skipped", deliveries: { "bs/you": { status: "skipped" } } }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/you"]?.status === "skipped");
    expect((await b.sync()).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60)]);
  });

  it("neither rebooks nor forgets across a restart two days later", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }, { path: B, frontmatter: fm(T0 + 100 * HOUR), body: "B" }] });
    const fake = fakeClient();
    await booker(c, fake, { t: T0 }).b.sync();
    expect(fake.sent).toHaveLength(2);
    const restarted = booker(c, fake, { t: T0 + 48 * HOUR });
    expect((await restarted.b.sync()).booked).toEqual([key(B, T0 + 100 * HOUR, 60), key(B, T0 + 100 * HOUR, 10)]);
    expect(new BookingLedger(c.app as never).all().map((x) => x.key)).toEqual([key(B, T0 + 100 * HOUR, 60), key(B, T0 + 100 * HOUR, 10)]);
    expect((await restarted.b.sync()).booked).toEqual([]);
  });

  it("sends a reminder just missed (within 5 minutes) at once, but not older ones", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 60 * MIN, { reminders: [62, 70] }), body: "A" }] });
    const fake = fakeClient();
    const r = await booker(c, fake, { t: T0 }).b.sync();
    expect(r.booked).toEqual([key(A, T0 + 60 * MIN, 62)]);
    expect(fake.sent[0]!.at).toBe(T0 - 2 * MIN);
  });

  it("never books an unreadable delivery entry", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { deliveries: { "bs/you": { status: "Scheduled!" } } }), body: "A" }] });
    const fake = fakeClient();
    expect((await booker(c, fake, { t: T0 }).b.sync()).booked).toEqual([]);
    expect(fake.calls()).toBe(0);
  });

  it("books only on the publisher; a device that loses the role withdraws its bookings (two fake devices, review focus 2)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    let synced = migrateSettings(null);
    const service = (deviceId: string) =>
      new PublisherService({ device: () => ({ deviceId, deviceName: deviceId }), settings: () => synced, update: async (p) => void (synced = { ...synced, ...p }), now: () => T0 });
    const laptop = service("laptop");
    const phone = service("phone");
    const phoneApp = new App();
    const laptopFake = fakeClient();
    const phoneFake = fakeClient();
    const onLaptop = booker(c, laptopFake, { t: T0 }, { isPublisher: () => laptop.isPublisher() });
    const onPhone = booker(c, phoneFake, { t: T0 }, { isPublisher: () => phone.isPublisher() }, phoneApp);
    await laptop.claim();
    await onLaptop.b.sync();
    await onPhone.b.sync();
    expect([laptopFake.sent.length, phoneFake.sent.length]).toEqual([2, 0]);
    await phone.claim();
    expect((await onLaptop.b.sync()).cancelled).toHaveLength(2);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
    expect((await onPhone.b.sync()).booked).toHaveLength(2);
  });

  it("withdraws when phone reminders are turned off, and forgets without cancelling on a new target", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    await b.sync();
    enabled = false;
    expect((await b.sync()).cancelled).toHaveLength(2);
    enabled = true;
    await b.sync();
    b.forget();
    expect(new BookingLedger(c.app as never).size()).toBe(0);
    expect(fake.cancelled).toHaveLength(2);
  });

  it("pauses 5 minutes after a failure and warns once per streak (review focus 3)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b, warnings } = booker(c, fake, now);
    fake.failWith(new NtfyError("server", "The ntfy server had a problem (502)."));
    expect((await b.sync()).failed).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    now.t += 30_000;
    await b.sync();
    expect(fake.calls()).toBe(1);
    now.t = T0 + RETRY_MS + 1;
    await b.sync();
    expect(fake.calls()).toBe(2);
    expect(warnings).toEqual(["Phone reminders: The ntfy server had a problem (502). Trying again in 5 min."]);
    fake.failWith(null);
    now.t = T0 + 2 * RETRY_MS + 2;
    expect((await b.sync()).booked).toHaveLength(2);
    fake.failWith(new NtfyError("rate_limited", "The ntfy server is limiting how often this device can send.", 20 * MIN));
    await writeNote(c.app as never, B, fm(T0 + 20 * HOUR), "B");
    await indexed(c.index, () => !!c.index.getVariant(B));
    await b.sync();
    expect(warnings.at(-1)).toBe("Phone reminders: The ntfy server is limiting how often this device can send. Trying again in 20 min.");
  });

  it("books at most 20 per run and runs one sync at a time", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    const [first, second] = await Promise.all([b.sync(), b.sync()]);
    expect(first).toBe(second);
    expect(first!.booked).toHaveLength(20);
    expect((await b.sync()).booked).toHaveLength(10);
  });

  it("stores the note's mtime as the booking version", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    await booker(c, fakeClient(), { t: T0 }).b.sync();
    const mtime = c.app.vault.getFileByPath(A)!.stat.mtime;
    expect(new BookingLedger(c.app as never).all().map((x) => x.version)).toEqual([mtime]);
  });

  it("cancels and rebooks a push when the note was edited since booking (M3 P9, server cancels)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    const file = await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60] }), "A, edited");
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1000 };
    await indexed(c.index, () => c.index.getVariant(A)?.excerpt.includes("edited") === true);
    now.t += 30_000;
    const r = await b.sync();
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[key(A, T0 + 10 * HOUR, 60)], [key(A, T0 + 10 * HOUR, 60)], []]);
    expect(fake.cancelled).toEqual(["m1"]);
    expect(fake.sent).toHaveLength(2);
    expect(new BookingLedger(c.app as never).all().map((x) => [x.messageId, x.version])).toEqual([["m2", file.stat.mtime]]);
    expect((await b.sync()).booked).toEqual([]);
  });

  it("keeps the old push and only records the new version when the server can't cancel (M3 P9)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    const file = await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60] }), "A, edited");
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1000 };
    await indexed(c.index, () => c.index.getVariant(A)?.excerpt.includes("edited") === true);
    now.t += 30_000;
    const r = await b.sync();
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[], [], [key(A, T0 + 10 * HOUR, 60)]]);
    expect(new BookingLedger(c.app as never).all().map((x) => [x.messageId, x.version])).toEqual([["m1", file.stat.mtime]]);
    now.t += 30_000;
    const again = await b.sync();
    expect([again.cancelled, again.booked, again.leftStale]).toEqual([[], [], []]);
    expect([fake.cancelled.length, fake.sent.length]).toEqual([1, 1]);
  });

  it("holds booking for 60 s after forget() (M3 P13)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    b.forget();
    now.t += 30_000;
    b.forget();
    now.t += 59_000;
    expect((await b.sync()).booked).toEqual([]);
    expect(fake.calls()).toBe(0);
    now.t += 1_001;
    expect((await b.sync()).booked).toHaveLength(2);
    expect(fake.calls()).toBe(2);
  });

  it("stops a run when forget() is called mid-run: no more publishes, nothing written after the clear (M3 P13)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    const release = fake.hold();
    const running = b.sync();
    await settle();
    expect(fake.calls()).toBe(1);
    b.forget();
    release();
    const r = await running;
    expect(r.booked).toEqual([]);
    expect(fake.calls()).toBe(1);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("keeps bookings it could not cancel while offline and cancels them on a later withdraw", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b, warnings } = booker(c, fake, now);
    await b.sync();
    fake.failCancelWith(new NtfyError("unreachable", "Couldn't reach the ntfy server.", 10 * MIN));
    const r = await b.withdraw();
    expect([r.cancelled, r.failed]).toEqual([[], [key(A, T0 + 10 * HOUR, 60)]]);
    expect(new BookingLedger(c.app as never).size()).toBe(2);
    expect(warnings).toEqual(["Phone reminders: Couldn't reach the ntfy server. Trying again in 10 min."]);
    await b.withdraw();
    expect(warnings).toHaveLength(1);
    fake.failCancelWith(null);
    expect((await b.withdraw()).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("retries a role-loss withdrawal on later runs once the pause is over", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    let publisher = true;
    const { b } = booker(c, fake, now, { isPublisher: () => publisher });
    await b.sync();
    publisher = false;
    fake.failCancelWith(new NtfyError("unreachable", "Couldn't reach the ntfy server."));
    expect((await b.sync()).failed).toHaveLength(1);
    fake.failCancelWith(null);
    now.t += 30_000;
    expect((await b.sync()).cancelled).toEqual([]);
    now.t = T0 + RETRY_MS + 1;
    expect((await b.sync()).cancelled).toHaveLength(2);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("counts version cancels against the budget and rebooks every one of them in the same run (M3 P9)", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await b.sync();
    expect(fake.sent).toHaveLength(30);
    for (const n of notes) {
      const file = c.app.vault.getFileByPath(n.path)!;
      file.stat = { ...file.stat, mtime: file.stat.mtime + 1000 };
    }
    const third = await b.sync();
    expect(third.cancelled).toHaveLength(20);
    expect(third.booked).toEqual(third.cancelled);
    const fourth = await b.sync();
    expect(fourth.cancelled).toHaveLength(10);
    expect(fourth.booked).toEqual(fourth.cancelled);
    expect(new BookingLedger(c.app as never).size()).toBe(30);
    expect((await b.sync()).booked).toEqual([]);
  });

  it("keeps an uncancellable push that is no longer wanted and revives it when wanted again", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 11 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 11 * HOUR);
    await b.sync();
    expect(fake.cancelled).toEqual(["m1"]);
    await b.sync();
    expect(fake.cancelled).toEqual(["m1"]);
    await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 10 * HOUR);
    const r = await b.sync();
    expect(r.booked).toEqual([]);
    expect(fake.sent).toHaveLength(2);
    const ledger = new BookingLedger(c.app as never).all();
    expect(ledger.map((x) => [x.key, x.messageId, x.stale === true])).toEqual([
      [key(A, T0 + 10 * HOUR, 60), "m1", false],
      [key(A, T0 + 11 * HOUR, 60), "m2", true],
    ]);
  });

  it("stops publishing as soon as this device loses the role mid-run", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    let publisher = true;
    const { b } = booker(c, fake, { t: T0 }, { isPublisher: () => publisher });
    fake.afterPublish(() => void (publisher = false));
    expect((await b.sync()).booked).toHaveLength(1);
    expect(fake.calls()).toBe(1);
    expect((await b.sync()).cancelled).toHaveLength(1);
  });

  it("withdraw waits at most 10 s for a hung run, then cancels what is booked", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    fake.afterPublish(() => void fake.hold());
    const hung = b.sync();
    await settle();
    await settle();
    expect(fake.calls()).toBe(2);
    enabled = false;
    vi.useFakeTimers();
    try {
      const withdrawn = b.withdraw();
      await vi.advanceTimersByTimeAsync(WITHDRAW_WAIT_MS - 1);
      expect(fake.cancelled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await withdrawn).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.cancelled).toEqual(["m1"]);
    void hung;
  });
});
