import type { PostRow } from "../../index/queries";
import { HOUR, MINUTE } from "../../model/dates";
import { fireTime, REMINDER_WINDOW_MS, reminderSlots, type ReminderItem } from "../reminders";
import type { Booking, BookingLedger } from "./bookings";
import { NtfyError, type NtfyClient, type NtfyMessage } from "./client";

/** ntfy.sh keeps delayed pushes at most 3 days (spec §4.4); 10 minutes of margin for clock skew. */
export const BOOKING_WINDOW_MS = 72 * HOUR - 10 * MINUTE;
/** Stay well under public-server rate limits; the rest is booked on the next run. */
export const MAX_BOOKINGS_PER_RUN = 20;
/** Pause after a failed run, so a down server is not called every 30 seconds. */
export const RETRY_MS = 5 * MINUTE;
/** Hold after forget() (M3 P13): the target fields call it on every keystroke; never book to a half-typed topic. */
export const FORGET_HOLD_MS = 60_000;

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

  constructor(private readonly deps: BookerDeps) {}

  /** Single-flight: a call during a run (or a withdraw) gets that run's result. Never rejects. */
  sync(): Promise<SyncResult> {
    return (this.running ??= this.track(this.run()));
  }

  /** Cancels every pending booking (where the server allows it) and clears the ledger. Runs after any sync in flight. */
  withdraw(): Promise<SyncResult> {
    const prior = this.running;
    const task = (async () => {
      if (prior) await prior;
      const result = emptyResult();
      try {
        await this.cancelAll(result);
      } catch {
        // Ledger storage failed; nothing more to do here.
      }
      return result;
    })();
    this.running = this.track(task);
    return this.running;
  }

  /** Clears the ledger without cancelling (the server, topic or token changed) and holds booking for 60 s. */
  forget(): void {
    this.deps.ledger.clear();
    this.pausedUntil = this.deps.now() + FORGET_HOLD_MS;
    this.warned = false;
  }

  private track(task: Promise<SyncResult>): Promise<SyncResult> {
    const tracked: Promise<SyncResult> = task.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    return tracked;
  }

  private async run(): Promise<SyncResult> {
    const result = emptyResult();
    let current = "";
    try {
      const now = this.deps.now();
      this.deps.ledger.prune(now - HOUR);
      if (!this.deps.isPublisher() || !this.deps.enabled()) {
        await this.cancelAll(result);
        return result;
      }
      if (now < this.pausedUntil) return result;
      const rows = this.deps.rows();
      // M3 P9: a booking carries the note's mtime; a later edit means the pre-filled text is outdated.
      const versions = new Map(rows.map((r) => [r.key, r.variant.file.stat.mtime]));
      const wanted = new Map<string, ReminderItem>();
      for (const item of reminderSlots(rows, now - REMINDER_WINDOW_MS, now + BOOKING_WINDOW_MS, now, (r) => this.deps.offsets(r))) {
        wanted.set(item.key, item);
      }
      for (const b of this.deps.ledger.all()) {
        if (b.fireAt <= now) continue;
        if (!wanted.has(b.key)) {
          current = b.key;
          await this.cancel(b, result);
          continue;
        }
        const version = versions.get(b.rowKey);
        if (version === undefined || version === b.version) continue;
        current = b.key;
        const outcome = await this.deps.client.cancel(b.messageId);
        if (outcome === "cancelled") {
          // Booked again below, with the current text.
          this.deps.ledger.remove(b.key);
          result.cancelled.push(b.key);
        } else {
          // The old push still arrives; don't send a second one, and don't try to cancel it again.
          this.deps.ledger.put({ ...b, version });
          result.leftStale.push(b.key);
        }
      }
      const have = new Set(this.deps.ledger.all().map((b) => b.key));
      let budget = MAX_BOOKINGS_PER_RUN;
      for (const item of wanted.values()) {
        if (have.has(item.key)) continue;
        if (budget === 0) break;
        budget--;
        current = item.key;
        const version = versions.get(rowKeyOf(item.key)) ?? 0;
        const message = await this.deps.compose(item);
        const sent = await this.deps.client.publish({ ...message, at: fireTime(item) });
        this.deps.ledger.put({ key: item.key, rowKey: rowKeyOf(item.key), minutes: item.minutes, messageId: sent.id, fireAt: fireTime(item), version });
        result.booked.push(item.key);
      }
      this.warned = false;
    } catch (e) {
      this.pause(e, result, current);
    }
    return result;
  }

  private async cancel(b: Booking, result: SyncResult): Promise<void> {
    const outcome = await this.deps.client.cancel(b.messageId);
    this.deps.ledger.remove(b.key);
    (outcome === "cancelled" ? result.cancelled : result.leftStale).push(b.key);
  }

  private async cancelAll(result: SyncResult): Promise<void> {
    const now = this.deps.now();
    const all = this.deps.ledger.all();
    if (!all.length) return;
    for (const b of all) {
      if (b.fireAt <= now) continue;
      try {
        await this.cancel(b, result);
      } catch {
        result.leftStale.push(b.key);
      }
    }
    this.deps.ledger.clear();
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
