import { describe, expect, it, vi } from "vitest";
import { App } from "../../fakes/obsidian";
import { formatDateTime } from "../../../src/model/dates";
import { BookingLedger, contentVersion } from "../../../src/reminders/ntfy/bookings";
import { BOOKING_WINDOW_MS, NtfyBooker, RETRY_MS, WITHDRAW_WAIT_MS, type BookerDeps } from "../../../src/reminders/ntfy/booker";
import { NtfyClient, NtfyError, REQUEST_TIMEOUT_MS, type CancelOutcome, type NtfyMessage } from "../../../src/reminders/ntfy/client";
import { NTFY } from "./fixtures";
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

function fakeClient(opts: { cancel?: CancelOutcome } = {}) {
  const sent: NtfyMessage[] = [];
  const cancelled: string[] = [];
  let calls = 0;
  let fail: Error | null = null;
  let cancelFail: Error | null = null;
  let gate: Promise<void> | null = null;
  let cancelGate: Promise<void> | null = null;
  let onPublish: () => void = () => {};
  return {
    sent,
    cancelled,
    calls: () => calls,
    failWith: (e: Error | null) => void (fail = e),
    failCancelWith: (e: Error | null) => void (cancelFail = e),
    /** Holds the next publish (one call) until the returned function is called. */
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
    /** Holds the next cancels (those not failing at once) until the returned function is called. */
    holdCancel: () => {
      let release!: () => void;
      cancelGate = new Promise<void>((r) => (release = r));
      return () => {
        cancelGate = null;
        release();
      };
    },
    afterPublish: (f: () => void) => void (onPublish = f),
    client: {
      publish: async (m: NtfyMessage) => {
        calls++;
        const held = gate;
        gate = null;
        if (held) await held;
        if (fail) throw fail;
        sent.push(m);
        onPublish();
        return { id: `m${sent.length}`, at: m.at ?? 0 };
      },
      cancel: async (id: string) => {
        if (cancelFail) throw cancelFail;
        if (cancelGate) await cancelGate;
        cancelled.push(id);
        return opts.cancel ?? ("cancelled" as const);
      },
    },
  };
}

function booker(c: TestCtx, fake: ReturnType<typeof fakeClient>, now: { t: number }, over: Partial<BookerDeps> = {}, app: App = c.app) {
  const warnings: string[] = [];
  /** revise(path) changes the composed push for that note, as a real content edit would. */
  const revisions = new Map<string, number>();
  const b = new NtfyBooker({
    rows: () => c.ctx.actions.rows(),
    offsets: (row) => row.variant.reminders ?? null,
    isPublisher: () => true,
    enabled: () => true,
    client: fake.client,
    ledger: new BookingLedger(app as never),
    compose: async (item) => ({ title: `In ${item.minutes} min`, message: `${item.title}\n${c.index.getVariant(item.path)?.excerpt ?? ""}${revisions.has(item.path) ? ` (r${revisions.get(item.path)})` : ""}` }),
    now: () => now.t,
    warn: (m) => void warnings.push(m),
    ...over,
  });
  return { b, warnings, revise: (path: string) => void revisions.set(path, (revisions.get(path) ?? 0) + 1) };
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

  it("stores a hash of the composed push as the booking version (final review 6)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    await booker(c, fake, { t: T0 }).b.sync();
    expect(new BookingLedger(c.app as never).all().map((x) => x.version)).toEqual([contentVersion(fake.sent[0]!)]);
  });

  it("does not rebook when only a delivery of another channel of the note changes (final review 6)", async () => {
    const two = (extra: Record<string, unknown> = {}) => fm(T0 + 10 * HOUR, { reminders: [60], channels: ["bs/you", "bs/two"], ...extra });
    const c = await makeCtx({ notes: [{ path: A, frontmatter: two(), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    expect((await b.sync()).booked).toHaveLength(2);
    const before = c.app.vault.getFileByPath(A)!.stat.mtime;
    const file = await writeNote(c.app as never, A, two({ deliveries: { "bs/two": { status: "awaiting_you" } } }), "A");
    file.stat = { ...file.stat, mtime: Math.max(file.stat.mtime, before + 1000) };
    await indexed(c.index, () => c.index.getVariant(A)?.deliveries["bs/two"]?.status === "awaiting_you");
    const mine = new BookingLedger(c.app as never).get(key(A, T0 + 10 * HOUR, 60))!;
    const other = new BookingLedger(c.app as never).all().find((x) => x.rowKey === `${A}#bs/two`)!.key;
    now.t += 30_000;
    const r = await b.sync();
    // bs/two now waits for the user (no reminder); bs/you's push is unchanged, so it is neither cancelled nor rebooked.
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[other], [], []]);
    expect(fake.sent).toHaveLength(2);
    expect(new BookingLedger(c.app as never).all()).toEqual([mine]);
  });

  it("cancels and rebooks a push when the note was edited since booking (M3 P9, server cancels)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60] }), "A, edited");
    await indexed(c.index, () => c.index.getVariant(A)?.excerpt.includes("edited") === true);
    now.t += 30_000;
    const r = await b.sync();
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[key(A, T0 + 10 * HOUR, 60)], [key(A, T0 + 10 * HOUR, 60)], []]);
    expect(fake.cancelled).toEqual(["m1"]);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.message).toContain("edited");
    expect(new BookingLedger(c.app as never).all().map((x) => [x.messageId, x.version])).toEqual([["m2", contentVersion(fake.sent[1]!)]]);
    expect((await b.sync()).booked).toEqual([]);
  });

  it("keeps the old push and only records the new version when the server can't cancel (M3 P9)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 10 * HOUR, { reminders: [60] }), "A, edited");
    await indexed(c.index, () => c.index.getVariant(A)?.excerpt.includes("edited") === true);
    now.t += 30_000;
    const r = await b.sync();
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[], [], [key(A, T0 + 10 * HOUR, 60)]]);
    const edited = contentVersion({ title: "In 60 min", message: `${c.index.getVariant(A)!.displayTitle}\nA, edited` });
    expect(new BookingLedger(c.app as never).all().map((x) => [x.messageId, x.version])).toEqual([["m1", edited]]);
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

  it("counts a version cancel and its rebook against the 20 requests of a run, and rebooks every one in the same run (M3 P9)", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    const { b, revise } = booker(c, fake, { t: T0 });
    await b.sync();
    await b.sync();
    expect(fake.sent).toHaveLength(30);
    for (const n of notes) revise(n.path);
    for (let run = 0; run < 3; run++) {
      const r = await b.sync();
      expect(r.cancelled).toHaveLength(10);
      expect(r.booked).toEqual(r.cancelled);
    }
    expect(fake.sent).toHaveLength(60);
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
    // The server can't cancel: no futile cancel of the revived push, only its version is brought up to date.
    expect(fake.cancelled).toEqual(["m1", "m2"]);
    const ledger = new BookingLedger(c.app as never).all();
    expect(ledger.map((x) => [x.key, x.messageId, x.stale === true])).toEqual([
      [key(A, T0 + 10 * HOUR, 60), "m1", false],
      [key(A, T0 + 11 * HOUR, 60), "m2", true],
    ]);
    expect(ledger[0]!.version).toBe(contentVersion(fake.sent[0]!));
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

  it("stop() ends a run in flight without a warning, and later calls send nothing (Task 9 fix round 1)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const { b, warnings } = booker(c, fake, { t: T0 });
    const release = fake.hold();
    const run = b.sync();
    await settle();
    expect(fake.calls()).toBe(1);
    b.stop();
    fake.failWith(new NtfyError("server", "The ntfy server had a problem."));
    release();
    await run;
    expect(warnings).toEqual([]);
    fake.failWith(null);
    expect(await b.sync()).toEqual({ booked: [], cancelled: [], leftStale: [], failed: [] });
    await b.withdraw();
    expect(fake.calls()).toBe(1);
    expect(fake.cancelled).toEqual([]);
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

  it("an abandoned run publishes nothing more, and a later run doesn't book what it still has in flight", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60, 30, 10] }), body: "A" }] });
    const fake = fakeClient();
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    let release = () => {};
    fake.afterPublish(() => {
      fake.afterPublish(() => {});
      release = fake.hold();
    });
    const r1 = b.sync();
    await settle();
    await settle();
    expect(fake.calls()).toBe(2);
    enabled = false;
    vi.useFakeTimers();
    try {
      const withdrawn = b.withdraw();
      await vi.advanceTimersByTimeAsync(WITHDRAW_WAIT_MS);
      expect((await withdrawn).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    } finally {
      vi.useRealTimers();
    }
    enabled = true;
    expect((await b.sync()).booked).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 10)]);
    release();
    await r1;
    expect((await b.sync()).booked).toEqual([]);
    expect(fake.sent).toHaveLength(4);
    const live = ["m1", "m2", "m3", "m4"].filter((id) => !fake.cancelled.includes(id));
    const ledger = new BookingLedger(c.app as never).all();
    expect(ledger.map((x) => x.key)).toEqual([key(A, T0 + 10 * HOUR, 60), key(A, T0 + 10 * HOUR, 30), key(A, T0 + 10 * HOUR, 10)]);
    expect(ledger.map((x) => x.messageId).sort()).toEqual(live);
  });

  it("records a push sent before a concurrent pause", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    let release = () => {};
    fake.afterPublish(() => {
      fake.afterPublish(() => {});
      release = fake.hold();
    });
    const r1 = b.sync();
    await settle();
    await settle();
    fake.failCancelWith(new NtfyError("unreachable", "Couldn't reach the ntfy server."));
    vi.useFakeTimers();
    try {
      const withdrawn = b.withdraw();
      await vi.advanceTimersByTimeAsync(WITHDRAW_WAIT_MS);
      expect((await withdrawn).failed).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    } finally {
      vi.useRealTimers();
    }
    release();
    await r1;
    expect(new BookingLedger(c.app as never).all().map((x) => x.messageId)).toEqual(["m1", "m2"]);
  });

  it("removes a booking whose version cancel succeeded after a concurrent pause", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b, revise } = booker(c, fake, now);
    await b.sync();
    revise(A);
    const release = fake.holdCancel();
    now.t += 30_000;
    const r1 = b.sync();
    await settle();
    fake.failCancelWith(new NtfyError("unreachable", "Couldn't reach the ntfy server."));
    vi.useFakeTimers();
    try {
      const withdrawn = b.withdraw();
      await vi.advanceTimersByTimeAsync(WITHDRAW_WAIT_MS);
      expect((await withdrawn).failed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    release();
    expect((await r1).cancelled).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    expect(fake.sent).toHaveLength(1);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("drops a booking the server no longer has, and rebooks it after an edit, without flagging cancel as unsupported", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "gone" });
    const now = { t: T0 };
    const { b, revise } = booker(c, fake, now);
    await b.sync();
    revise(A);
    now.t += 30_000;
    expect((await b.sync()).booked).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    await writeNote(c.app as never, A, fm(T0 + 11 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 11 * HOUR);
    const r = await b.sync();
    expect([r.cancelled, r.leftStale]).toEqual([[key(A, T0 + 10 * HOUR, 60)], []]);
    expect(new BookingLedger(c.app as never).all().map((x) => x.key)).toEqual([key(A, T0 + 11 * HOUR, 60)]);
    expect(b.cancelSupported()).toBe(true);
  });

  it("keeps an edited push the server refused to cancel, warns once and links that note's later pushes through Obsidian (final review 7)", async () => {
    const c = await makeCtx({
      notes: [
        { path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" },
        { path: B, frontmatter: fm(T0 + 20 * HOUR, { reminders: [60] }), body: "B" },
      ],
    });
    const fake = fakeClient({ cancel: "refused" });
    const now = { t: T0 };
    const { b, warnings, revise } = booker(c, fake, now);
    await b.sync();
    revise(A);
    now.t += 30_000;
    const r = await b.sync();
    expect([r.cancelled, r.booked, r.leftStale]).toEqual([[], [], [key(A, T0 + 10 * HOUR, 60)]]);
    expect([b.cancelSupported(A), b.cancelSupported(B), b.cancelSupported()]).toEqual([false, true, true]);
    expect(warnings).toEqual(["Phone reminders: the ntfy server refused to withdraw a reminder for an edited post, so its earlier push will still arrive. Later reminders for that post open through Obsidian."]);
    // A later edit of the same note: no futile cancel, only the version is brought up to date. B still cancels.
    revise(A);
    revise(B);
    now.t += 30_000;
    const again = await b.sync();
    expect([again.cancelled, again.booked, again.leftStale]).toEqual([[], [], [key(A, T0 + 10 * HOUR, 60), key(B, T0 + 20 * HOUR, 60)]]);
    expect(fake.cancelled).toEqual(["m1", "m2"]);
    expect(warnings).toHaveLength(1);
    expect((await b.sync()).leftStale).toEqual([]);
  });

  it("keeps a push the server refused to cancel as stale, without flagging cancel as unsupported", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient({ cancel: "refused" });
    const { b } = booker(c, fake, { t: T0 });
    await b.sync();
    await writeNote(c.app as never, A, fm(T0 + 11 * HOUR, { reminders: [60] }), "A");
    await indexed(c.index, () => c.index.getVariant(A)?.scheduledAt === T0 + 11 * HOUR);
    expect((await b.sync()).leftStale).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    expect(new BookingLedger(c.app as never).get(key(A, T0 + 10 * HOUR, 60))?.stale).toBe(true);
    expect(b.cancelSupported()).toBe(true);
  });

  it("withdraw keeps uncancellable pushes as stale until their time and revives them when turned back on", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient({ cancel: "unsupported" });
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    await b.sync();
    enabled = false;
    expect((await b.withdraw()).leftStale).toHaveLength(2);
    expect(new BookingLedger(c.app as never).all().map((x) => x.stale)).toEqual([true, true]);
    await b.withdraw();
    await b.sync();
    expect(fake.cancelled).toHaveLength(2);
    enabled = true;
    expect((await b.sync()).booked).toEqual([]);
    expect(fake.sent).toHaveLength(2);
    expect(new BookingLedger(c.app as never).all().map((x) => x.stale === true)).toEqual([false, false]);
  });

  it("makes at most 20 cancel requests per run for bookings no longer wanted, the rest on the next run", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    let on = true;
    const { b } = booker(c, fake, { t: T0 }, { offsets: (row) => (on ? (row.variant.reminders ?? null) : []) });
    await b.sync();
    await b.sync();
    on = false;
    expect((await b.sync()).cancelled).toHaveLength(20);
    expect((await b.sync()).cancelled).toHaveLength(10);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("makes at most 20 cancel requests per run when the device loses the role", async () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ path: `Social/Posts/N${i}.md`, frontmatter: fm(T0 + (i + 2) * HOUR), body: `N${i}` }));
    const c = await makeCtx({ notes });
    const fake = fakeClient();
    let publisher = true;
    const { b } = booker(c, fake, { t: T0 }, { isPublisher: () => publisher });
    await b.sync();
    await b.sync();
    publisher = false;
    expect((await b.sync()).cancelled).toHaveLength(20);
    expect((await b.sync()).cancelled).toHaveLength(10);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("abandons a run stuck for over 60 s: a later sync starts afresh and books the rest (final review 2)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b, warnings } = booker(c, fake, now);
    fake.hold();
    const stuck = b.sync();
    await settle();
    expect(fake.calls()).toBe(1);
    now.t += 59_000;
    expect(b.sync()).toBe(stuck);
    now.t += 1_001;
    const fresh = b.sync();
    expect(fresh).not.toBe(stuck);
    // The stuck push is still in flight: never booked a second time.
    expect((await fresh).booked).toEqual([key(A, T0 + 10 * HOUR, 10)]);
    expect([fake.calls(), warnings]).toEqual([2, []]);
  });

  it("never publishes twice when an abandoned run records a push while the fresh run is busy with an earlier one (re-review R1)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    const releaseOld = fake.hold();
    const old = b.sync();
    await settle();
    expect(fake.calls()).toBe(1);
    await writeNote(c.app as never, B, fm(T0 + 5 * HOUR, { reminders: [60] }), "B");
    await indexed(c.index, () => !!c.index.getVariant(B));
    now.t += 61_000;
    const releaseFresh = fake.hold();
    const fresh = b.sync();
    await settle();
    expect(fake.calls()).toBe(2);
    releaseOld();
    await old;
    releaseFresh();
    const r = await fresh;
    expect(r.booked).toEqual([key(B, T0 + 5 * HOUR, 60)]);
    expect(fake.sent.filter((m) => m.at === T0 + 9 * HOUR)).toHaveLength(1);
    expect(fake.calls()).toBe(2);
    expect(new BookingLedger(c.app as never).get(key(A, T0 + 10 * HOUR, 60))?.messageId).toBe("m1");
  });

  it("a push the server never answers times out, warns once and is booked again after the pause (final review 2)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const now = { t: T0 };
    let answer = false;
    const calls: string[] = [];
    const client = new NtfyClient(
      () => ({ server: "https://ntfy.sh", topic: "osmm-SECRETTOPIC", token: null }),
      async (req) => {
        calls.push(String(req.method));
        if (!answer) return new Promise(() => undefined);
        return NTFY.scheduled() as never;
      },
      () => now.t,
    );
    const { b, warnings } = booker(c, fakeClient(), now, { client });
    vi.useFakeTimers();
    try {
      const first = b.sync();
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect((await first).failed).toEqual([key(A, T0 + 10 * HOUR, 60)]);
      expect(warnings).toEqual([`Phone reminders: The ntfy server did not answer within 30 s. Check the server address and the connection. Trying again in 5 min.`]);
      now.t += 60_000;
      expect((await b.sync()).booked).toEqual([]);
      answer = true;
      now.t = T0 + RETRY_MS;
      expect((await b.sync()).booked).toEqual([key(A, T0 + 10 * HOUR, 60)]);
    } finally {
      vi.useRealTimers();
    }
    expect([calls.length, warnings.length]).toEqual([2, 1]);
  });

  it("records nothing in the ledger once stopped, even for a push that went out (final review 8)", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    const { b } = booker(c, fake, { t: T0 });
    const release = fake.hold();
    const run = b.sync();
    await settle();
    b.stop();
    release();
    expect((await run).booked).toEqual([]);
    expect(fake.sent).toHaveLength(1);
    expect(new BookingLedger(c.app as never).size()).toBe(0);
  });

  it("removes nothing from the ledger once stopped, even for a cancel that succeeded", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR, { reminders: [60] }), body: "A" }] });
    const fake = fakeClient();
    let enabled = true;
    const { b } = booker(c, fake, { t: T0 }, { enabled: () => enabled });
    await b.sync();
    enabled = false;
    const release = fake.holdCancel();
    const run = b.sync();
    await settle();
    b.stop();
    release();
    expect((await run).cancelled).toEqual([]);
    expect(new BookingLedger(c.app as never).size()).toBe(1);
  });

  it("a shorter failure pause never cuts a longer one short", async () => {
    const c = await makeCtx({ notes: [{ path: A, frontmatter: fm(T0 + 10 * HOUR), body: "A" }] });
    const fake = fakeClient();
    const now = { t: T0 };
    const { b } = booker(c, fake, now);
    await b.sync();
    await writeNote(c.app as never, B, fm(T0 + 20 * HOUR), "B");
    await indexed(c.index, () => !!c.index.getVariant(B));
    fake.failWith(new NtfyError("rate_limited", "The ntfy server is limiting how often this device can send.", 20 * MIN));
    await b.sync();
    fake.failCancelWith(new NtfyError("unreachable", "Couldn't reach the ntfy server."));
    await b.withdraw();
    fake.failWith(null);
    fake.failCancelWith(null);
    const calls = fake.calls();
    now.t = T0 + 6 * MIN;
    await b.sync();
    expect(fake.calls()).toBe(calls);
    now.t = T0 + 20 * MIN + 1;
    expect((await b.sync()).booked).toEqual([key(B, T0 + 20 * HOUR, 60), key(B, T0 + 20 * HOUR, 10)]);
  });
});
