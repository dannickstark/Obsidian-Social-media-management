import type { App } from "obsidian";
import { isRecord } from "../../model/frontmatter";

/** One push this device booked on ntfy (#69: {deliveryId, offset, messageId, at}). */
export interface Booking {
  /** The reminder key (`<row key>@<post time>:<minutes>`): a rescheduled post gets new keys. */
  key: string;
  /** The delivery: `<note path>#<channel id>`. */
  rowKey: string;
  minutes: number;
  /** The id the ntfy server gave the message; used to cancel it. */
  messageId: string;
  /** When the push is due on the phone (epoch ms). */
  fireAt: number;
  /** The note's mtime at booking time (M3 P9): a later edit means the booked text is stale. */
  version: number;
}

const KEY = "osmm-ntfy-bookings";

/** Device-local ledger of booked pushes (never the topic or the token), so a restart does not book twice. */
export class BookingLedger {
  constructor(private readonly app: App) {}

  all(): Booking[] {
    const raw: unknown = this.app.loadLocalStorage(KEY);
    if (!isRecord(raw)) return [];
    const out: Booking[] = [];
    for (const [key, v] of Object.entries(raw)) {
      if (!isRecord(v)) continue;
      const { rowKey, minutes, messageId, fireAt, version } = v;
      if (
        typeof rowKey === "string" &&
        typeof minutes === "number" &&
        typeof messageId === "string" &&
        typeof fireAt === "number" &&
        typeof version === "number"
      ) {
        out.push({ key, rowKey, minutes, messageId, fireAt, version });
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
  }

  size(): number {
    return this.all().length;
  }

  get(key: string): Booking | undefined {
    return this.all().find((b) => b.key === key);
  }

  put(booking: Booking): void {
    this.save([...this.all().filter((b) => b.key !== booking.key), booking]);
  }

  remove(key: string): void {
    this.save(this.all().filter((b) => b.key !== key));
  }

  /** Drops bookings whose push time is before `before` (they have gone out). */
  prune(before: number): void {
    const all = this.all();
    const kept = all.filter((b) => b.fireAt >= before);
    if (kept.length !== all.length) this.save(kept);
  }

  clear(): void {
    if (this.app.loadLocalStorage(KEY) !== null) this.app.saveLocalStorage(KEY, null);
  }

  private save(list: readonly Booking[]): void {
    if (!list.length) return this.clear();
    const out: Record<string, Omit<Booking, "key">> = {};
    for (const { key, rowKey, minutes, messageId, fireAt, version } of list) out[key] = { rowKey, minutes, messageId, fireAt, version };
    this.app.saveLocalStorage(KEY, out);
  }
}
