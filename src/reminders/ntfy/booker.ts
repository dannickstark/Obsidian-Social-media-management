import type { PostRow } from "../../index/queries";
import { HOUR, MINUTE } from "../../model/dates";
import { fireTime, REMINDER_WINDOW_MS, reminderSlots, type ReminderItem } from "../reminders";
import type { Booking, BookingLedger } from "./bookings";
import { NtfyError, type CancelOutcome, type NtfyClient, type NtfyMessage } from "./client";
import { settlesWithin } from "../../util/time";

/** ntfy.sh keeps delayed pushes at most 3 days (spec §4.4); 10 minutes of margin for clock skew. */
export const BOOKING_WINDOW_MS = 72 * HOUR - 10 * MINUTE;
/** Requests (bookings and cancels) per run, to stay well under public-server rate limits; the rest waits for the next run. */
export const MAX_BOOKINGS_PER_RUN = 20;
/** Pause after a failed run, so a down server is not called every 30 seconds. */
export const RETRY_MS = 5 * MINUTE;
/** Hold after forget() (M3 P13): the target fields call it on every keystroke; never book to a half-typed topic. */
export const FORGET_HOLD_MS = 60_000;
/** Turning phone reminders off must not hang on a stuck run (Task 9 ruling). */
export const WITHDRAW_WAIT_MS = 10_000;
/** A sync run still going after this is abandoned by the next sync, which starts afresh (final review 2). */
export const STALLED_RUN_MS = 60_000;

export interface BookerDeps {
  rows(): PostRow[];
  /** Minutes-before list for a row; null for rows that post by themselves (ReminderService.offsets). */
  offsets(row: PostRow): readonly number[] | null;
  isPublisher(): boolean;
  /** Phone reminders are on for this device. */
  enabled(): boolean;
  client: Pick<NtfyClient, "publish" | "cancel">;
  ledger: BookingLedger;
  compose(item: ReminderItem): Promise<NtfyMessage>;
  now(): number;
  warn(message: string): void;
}

export interface SyncResult {
  booked: string[];
  cancelled: string[];
  /** Bookings that no longer apply (or carry outdated text) but could not be cancelled; the push will still arrive. */
  leftStale: string[];
  failed: string[];
}

const emptyResult = (): SyncResult => ({ booked: [], cancelled: [], leftStale: [], failed: [] });
const rowKeyOf = (key: string) => key.replace(/@\d+:\d+$/, "");

/**
 * Spec §4.4: every run on the publisher device books the phone reminders due in the next 72 hours and
 * cancels the ones that no longer apply. Deliveries are only read, never written: booking is not publishing.
 */
export class NtfyBooker {
  private running: Promise<SyncResult> | null = null;
  /** When the sync run in `running` started; null while `running` is a withdraw (never abandoned by a sync). */
  private runStarted: number | null = null;
  private pausedUntil = 0;
  private warned = false;
  /** Bumped by forget(): a run started before it must not send or record anything more (M3 P13). */
  private generation = 0;
  /** Bumped when withdraw() stops waiting for a hung run: that run sends nothing more, but records what it sent. */
  private abandoned = 0;
  /** Reminder keys being published right now, by any run: a later run never books them a second time. */
  private readonly inFlight = new Set<string>();
  /** Set by stop() on unload: nothing more is sent and nothing is shown. */
  private halted = false;

  constructor(private readonly deps: BookerDeps) {}

  /**
   * Single-flight: a call during a run (or a withdraw) gets that run's result, unless the run has been going for
   * over 60 s: it is then abandoned (it sends nothing more) and a fresh run starts. Never rejects.
   */
  sync(): Promise<SyncResult> {
    if (this.halted) return Promise.resolve(emptyResult());
    const now = this.deps.now();
    if (this.running && this.runStarted !== null && now - this.runStarted > STALLED_RUN_MS) {
      this.abandoned++;
      this.running = null;
    }
    if (!this.running) {
      this.runStarted = now;
      this.running = this.track(this.run());
    }
    return this.running;
  }

  /**
   * Cancels every pending booking (where the server allows it). Waits at most 10 s for a run in flight (Task 9
   * ruling), then abandons it. Entries whose cancel failed stay in the ledger for later runs; pushes the server
   * can't cancel stay, marked stale, until their time. Ignores the failure pause: the user asked.
   */
  withdraw(): Promise<SyncResult> {
    if (this.halted) return Promise.resolve(emptyResult());
    const prior = this.running;
    const task = (async () => {
      if (prior && !(await settlesWithin(prior, WITHDRAW_WAIT_MS))) this.abandoned++;
      const gen = this.generation;
      // Nothing is recorded after forget() cleared the ledger, or after stop() (the plugin instance is gone).
      const forgotten = () => gen !== this.generation || this.halted;
      const halted = forgotten;
      const result = emptyResult();
      try {
        if (await this.cancelAll(result, { left: Number.POSITIVE_INFINITY }, halted, forgotten)) this.warned = false;
      } catch (e) {
        if (!forgotten()) this.pause(e, result, "");
      }
      return result;
    })();
    this.runStarted = null;
    this.running = this.track(task);
    return this.running;
  }

  /** Clears the ledger without cancelling (the server, topic or token changed) and holds booking for 60 s. */
  forget(): void {
    this.generation++;
    this.deps.ledger.clear();
    this.deps.ledger.resetCancelSupport();
    this.pausedUntil = this.deps.now() + FORGET_HOLD_MS;
    this.warned = false;
  }

  /** The plugin unloads: a run in flight sends nothing more (checked before every request), and no warning shows. */
  stop(): void {
    this.halted = true;
    this.abandoned++;
  }

  /** False once the server said it can't cancel pushes (Task 8 ruling): pushes should then link through Obsidian. */
  cancelSupported(): boolean {
    return this.deps.ledger.cancelSupported();
  }

  private track(task: Promise<SyncResult>): Promise<SyncResult> {
    const tracked: Promise<SyncResult> = task.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    return tracked;
  }

  private active(): boolean {
    return this.deps.isPublisher() && this.deps.enabled();
  }

  private async run(): Promise<SyncResult> {
    const gen = this.generation;
    const epoch = this.abandoned;
    /** Checked before every request or write. */
    const stopped = () => gen !== this.generation || epoch !== this.abandoned || this.deps.now() < this.pausedUntil;
    /**
     * Checked after every request: the server's answer is recorded unless forget() cleared the ledger (M3 P13) or
     * stop() ended this plugin instance (final review 8).
     */
    const forgotten = () => gen !== this.generation || this.halted;
    const result = emptyResult();
    /** Requests left in this run: cancels and bookings alike. */
    const budget = { left: MAX_BOOKINGS_PER_RUN };
    let current = "";
    try {
      const now = this.deps.now();
      if (now < this.pausedUntil) return result;
      this.deps.ledger.prune(now - HOUR);
      if (!this.active()) {
        if (await this.cancelAll(result, budget, stopped, forgotten)) this.warned = false;
        return result;
      }
      const rows = this.deps.rows();
      // M3 P9: a booking carries the note's mtime; a later edit means the pre-filled text is outdated.
      const versions = new Map(rows.map((r) => [r.key, r.variant.file.stat.mtime]));
      const wanted = new Map<string, ReminderItem>();
      for (const item of reminderSlots(rows, now - REMINDER_WINDOW_MS, now + BOOKING_WINDOW_MS, now, (r) => this.deps.offsets(r))) {
        wanted.set(item.key, item);
      }
      /** Cancelled for an edit: rebooked in this run, their request already counted with the cancel. */
      const rebook = new Set<string>();
      for (const found of this.deps.ledger.all()) {
        let b = found;
        if (b.fireAt <= now) continue;
        if (!wanted.has(b.key)) {
          if (b.stale || budget.left === 0) continue;
          if (stopped()) return result;
          budget.left--;
          current = b.key;
          const outcome = await this.deps.client.cancel(b.messageId);
          if (forgotten()) return result;
          this.settleUnwanted(b, outcome, result);
          continue;
        }
        if (b.stale) {
          if (stopped()) return result;
          b = { ...b, stale: false };
          this.deps.ledger.put(b);
        }
        const version = versions.get(b.rowKey);
        if (version === undefined || version === b.version) continue;
        if (found.stale && !this.cancelSupported()) {
          // A revived push the server can't cancel: a cancel would be futile.
          this.deps.ledger.put({ ...b, version });
          continue;
        }
        if (budget.left < 2) continue;
        if (stopped()) return result;
        budget.left -= 2; // the cancel and its rebook
        current = b.key;
        const outcome = await this.deps.client.cancel(b.messageId);
        if (forgotten()) return result;
        if (outcome === "cancelled" || outcome === "gone") {
          this.deps.ledger.remove(b.key);
          result.cancelled.push(b.key);
          rebook.add(b.key);
        } else {
          // The old push still arrives; don't send a second one, and don't try to cancel it again.
          if (outcome === "unsupported") this.deps.ledger.markCancelUnsupported();
          this.deps.ledger.put({ ...b, version });
          result.leftStale.push(b.key);
          budget.left++;
        }
      }
      const have = new Set(this.deps.ledger.all().map((b) => b.key));
      for (const item of wanted.values()) {
        if (have.has(item.key) || this.inFlight.has(item.key)) continue;
        const reserved = rebook.has(item.key);
        if (!reserved && budget.left === 0) continue;
        if (stopped() || !this.active()) return result;
        if (!reserved) budget.left--;
        current = item.key;
        this.inFlight.add(item.key);
        try {
          const version = versions.get(rowKeyOf(item.key)) ?? 0;
          const message = await this.deps.compose(item);
          if (stopped() || !this.active()) return result;
          const sent = await this.deps.client.publish({ ...message, at: fireTime(item) });
          // Recorded even after a pause, an abandon or a role change, so it can be cancelled later; not after forget() or stop().
          if (forgotten()) return result;
          this.deps.ledger.put({ key: item.key, rowKey: rowKeyOf(item.key), minutes: item.minutes, messageId: sent.id, fireAt: fireTime(item), version });
          result.booked.push(item.key);
        } finally {
          this.inFlight.delete(item.key);
        }
      }
      this.warned = false;
    } catch (e) {
      if (!forgotten()) this.pause(e, result, current);
    }
    return result;
  }

  /** Records the answer to a cancel of a booking that no longer applies. */
  private settleUnwanted(b: Booking, outcome: CancelOutcome, result: SyncResult): void {
    if (outcome === "cancelled" || outcome === "gone") {
      this.deps.ledger.remove(b.key);
      result.cancelled.push(b.key);
      return;
    }
    // The push still arrives: keep it until its time, so a return to this slot doesn't book a second one.
    if (outcome === "unsupported") this.deps.ledger.markCancelUnsupported();
    this.deps.ledger.put({ ...b, stale: true });
    result.leftStale.push(b.key);
  }

  /**
   * Cancels pending bookings one by one, recording each answer. Pushes already due or known to be uncancellable are
   * left for the prune. On a failure it pauses and stops, keeping the rest for a later run. True when all are settled.
   */
  private async cancelAll(result: SyncResult, budget: { left: number }, stopped: () => boolean, forgotten: () => boolean): Promise<boolean> {
    for (const b of this.deps.ledger.all()) {
      if (b.stale || b.fireAt <= this.deps.now()) continue;
      if (budget.left <= 0 || stopped()) return false;
      budget.left--;
      let outcome: CancelOutcome;
      try {
        outcome = await this.deps.client.cancel(b.messageId);
      } catch (e) {
        if (!forgotten()) this.pause(e, result, b.key);
        return false;
      }
      if (forgotten()) return false;
      this.settleUnwanted(b, outcome, result);
    }
    return true;
  }

  private pause(e: unknown, result: SyncResult, key: string): void {
    const now = this.deps.now();
    const wait = e instanceof NtfyError && e.retryAfterMs ? Math.max(e.retryAfterMs, RETRY_MS) : RETRY_MS;
    this.pausedUntil = Math.max(this.pausedUntil, now + wait);
    if (key) result.failed.push(key);
    if (this.warned || this.halted) return;
    this.warned = true;
    // Only NtfyError messages are shown: they are scrubbed of the topic and token by the client.
    const reason = e instanceof NtfyError ? e.message : "a reminder could not be prepared.";
    this.deps.warn(`Phone reminders: ${reason} Trying again in ${Math.round((this.pausedUntil - now) / MINUTE)} min.`);
  }
}
