import type { PostRow } from "../../index/queries";
import { HOUR, MINUTE } from "../../model/dates";
import { fireTime, REMINDER_WINDOW_MS, reminderSlots, type ReminderItem } from "../reminders";
import type { BookingLedger } from "./bookings";
import { NtfyError, type NtfyClient, type NtfyMessage } from "./client";

/** ntfy.sh keeps delayed pushes at most 3 days (spec §4.4); 10 minutes of margin for clock skew. */
export const BOOKING_WINDOW_MS = 72 * HOUR - 10 * MINUTE;
/** Stay well under public-server rate limits; the rest is booked on the next run. */
export const MAX_BOOKINGS_PER_RUN = 20;
/** Pause after a failed run, so a down server is not called every 30 seconds. */
export const RETRY_MS = 5 * MINUTE;
/** Hold after forget() (M3 P13): the target fields call it on every keystroke; never book to a half-typed topic. */
export const FORGET_HOLD_MS = 60_000;
/** Turning phone reminders off must not hang on a stuck run (Task 9 ruling). */
export const WITHDRAW_WAIT_MS = 10_000;

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
  private pausedUntil = 0;
  private warned = false;
  /** Bumped by forget(): a run started before it must not send or record anything more (M3 P13). */
  private generation = 0;

  constructor(private readonly deps: BookerDeps) {}

  /** Single-flight: a call during a run (or a withdraw) gets that run's result. Never rejects. */
  sync(): Promise<SyncResult> {
    return (this.running ??= this.track(this.run()));
  }

  /**
   * Cancels every pending booking (where the server allows it). Waits at most 10 s for a run in flight (Task 9 ruling).
   * Entries whose cancel failed stay in the ledger and are retried by later runs. Ignores the failure pause: the user asked.
   */
  withdraw(): Promise<SyncResult> {
    const prior = this.running;
    const task = (async () => {
      if (prior) await waitAtMost(prior, WITHDRAW_WAIT_MS);
      const result = emptyResult();
      try {
        if (await this.cancelAll(result, this.generation)) this.warned = false;
      } catch (e) {
        this.pause(e, result, "");
      }
      return result;
    })();
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

  /** False once the server refused a cancel (Task 8 ruling): pushes should then link through Obsidian. */
  cancelSupported(): boolean {
    return this.deps.ledger.cancelSupported();
  }

  private track(task: Promise<SyncResult>): Promise<SyncResult> {
    const tracked: Promise<SyncResult> = task.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    return tracked;
  }

  /** The run must stop: forget() was called, or booking is on hold. */
  private halted(generation: number): boolean {
    return generation !== this.generation || this.deps.now() < this.pausedUntil;
  }

  private active(): boolean {
    return this.deps.isPublisher() && this.deps.enabled();
  }

  private async run(): Promise<SyncResult> {
    const gen = this.generation;
    const result = emptyResult();
    let current = "";
    try {
      const now = this.deps.now();
      if (now < this.pausedUntil) return result;
      this.deps.ledger.prune(now - HOUR);
      if (!this.active()) {
        if (await this.cancelAll(result, gen)) this.warned = false;
        return result;
      }
      const rows = this.deps.rows();
      // M3 P9: a booking carries the note's mtime; a later edit means the pre-filled text is outdated.
      const versions = new Map(rows.map((r) => [r.key, r.variant.file.stat.mtime]));
      const wanted = new Map<string, ReminderItem>();
      for (const item of reminderSlots(rows, now - REMINDER_WINDOW_MS, now + BOOKING_WINDOW_MS, now, (r) => this.deps.offsets(r))) {
        wanted.set(item.key, item);
      }
      let budget = MAX_BOOKINGS_PER_RUN;
      /** Cancelled for an edit: rebooked in this run, their budget already taken by the cancel. */
      const rebook = new Set<string>();
      for (const found of this.deps.ledger.all()) {
        let b = found;
        if (b.fireAt <= now) continue;
        if (!wanted.has(b.key)) {
          if (b.stale) continue;
          if (this.halted(gen)) return result;
          current = b.key;
          const outcome = await this.deps.client.cancel(b.messageId);
          if (this.halted(gen)) return result;
          if (outcome === "cancelled") {
            this.deps.ledger.remove(b.key);
            result.cancelled.push(b.key);
          } else {
            // The push still arrives: keep it until its time, so a return to this slot doesn't book a second one.
            this.deps.ledger.markCancelUnsupported();
            this.deps.ledger.put({ ...b, stale: true });
            result.leftStale.push(b.key);
          }
          continue;
        }
        if (b.stale) {
          if (this.halted(gen)) return result;
          b = { ...b, stale: false };
          this.deps.ledger.put(b);
        }
        const version = versions.get(b.rowKey);
        if (version === undefined || version === b.version || budget === 0) continue;
        if (this.halted(gen)) return result;
        budget--;
        current = b.key;
        const outcome = await this.deps.client.cancel(b.messageId);
        if (this.halted(gen)) return result;
        if (outcome === "cancelled") {
          this.deps.ledger.remove(b.key);
          result.cancelled.push(b.key);
          rebook.add(b.key);
        } else {
          // The old push still arrives; don't send a second one, and don't try to cancel it again.
          this.deps.ledger.markCancelUnsupported();
          this.deps.ledger.put({ ...b, version });
          result.leftStale.push(b.key);
        }
      }
      const have = new Set(this.deps.ledger.all().map((b) => b.key));
      for (const item of wanted.values()) {
        if (have.has(item.key)) continue;
        const reserved = rebook.has(item.key);
        if (!reserved && budget === 0) continue;
        if (this.halted(gen) || !this.active()) return result;
        if (!reserved) budget--;
        current = item.key;
        const version = versions.get(rowKeyOf(item.key)) ?? 0;
        const message = await this.deps.compose(item);
        if (this.halted(gen) || !this.active()) return result;
        const sent = await this.deps.client.publish({ ...message, at: fireTime(item) });
        // Recorded even if the role was lost meanwhile, so the next run can cancel it; not after forget().
        if (this.halted(gen)) return result;
        this.deps.ledger.put({ key: item.key, rowKey: rowKeyOf(item.key), minutes: item.minutes, messageId: sent.id, fireAt: fireTime(item), version });
        result.booked.push(item.key);
      }
      this.warned = false;
    } catch (e) {
      if (gen === this.generation) this.pause(e, result, current);
    }
    return result;
  }

  /**
   * Cancels pending bookings one by one, removing each once the server answered. On a failure it pauses and
   * stops, keeping the rest for a later run. True when every entry was settled.
   */
  private async cancelAll(result: SyncResult, gen: number): Promise<boolean> {
    for (const b of this.deps.ledger.all()) {
      if (gen !== this.generation) return false;
      if (b.fireAt <= this.deps.now() || b.stale) {
        this.deps.ledger.remove(b.key);
        continue;
      }
      let outcome: "cancelled" | "unsupported";
      try {
        outcome = await this.deps.client.cancel(b.messageId);
      } catch (e) {
        if (gen === this.generation) this.pause(e, result, b.key);
        return false;
      }
      if (gen !== this.generation) return false;
      this.deps.ledger.remove(b.key);
      if (outcome === "unsupported") this.deps.ledger.markCancelUnsupported();
      (outcome === "cancelled" ? result.cancelled : result.leftStale).push(b.key);
    }
    return true;
  }

  private pause(e: unknown, result: SyncResult, key: string): void {
    const wait = e instanceof NtfyError && e.retryAfterMs ? Math.max(e.retryAfterMs, RETRY_MS) : RETRY_MS;
    this.pausedUntil = this.deps.now() + wait;
    if (key) result.failed.push(key);
    if (this.warned) return;
    this.warned = true;
    // Only NtfyError messages are shown: they are scrubbed of the topic and token by the client.
    const reason = e instanceof NtfyError ? e.message : "a reminder could not be prepared.";
    this.deps.warn(`Phone reminders: ${reason} Trying again in ${Math.round(wait / MINUTE)} min.`);
  }
}

/** Resolves when `task` settles or after `ms`, whichever comes first; never rejects. */
function waitAtMost(task: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([task.then(() => undefined, () => undefined), timeout]).finally(() => clearTimeout(timer));
}
