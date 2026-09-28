import type { App } from "obsidian";
import { isRecord } from "../../model/frontmatter";
import type { NtfyMessage } from "./client";
import { cyrb53 } from "../../util/hash";

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
  /**
   * A hash of the push as booked (contentVersion; final review 6, replacing M3 P9's note mtime): when the push
   * composed now differs, the booked one carries outdated text and is replaced.
   */
  version: number;
  /** The push no longer applies but the server could not cancel it: it still arrives, so it is kept until its time. */
  stale?: boolean;
}

const KEY = "osmm-ntfy-bookings";
const CANCEL_UNSUPPORTED_KEY = "osmm-ntfy-cancel-unsupported";
const CANCEL_REFUSED_KEY = "osmm-ntfy-cancel-refused";

/**
 * A stable 53-bit hash (cyrb53) of what a push shows and links to: title, text, click link and actions. Priority,
 * tags and the delivery time are left out: a new time gives a new reminder key anyway.
 */
export function contentVersion(msg: Pick<NtfyMessage, "title" | "message" | "click" | "actions">): number {
  return cyrb53(JSON.stringify([msg.title, msg.message, msg.click ?? null, msg.actions ?? []]));
}

/** Device-local ledger of booked pushes (never the topic or the token), so a restart does not book twice. */
export class BookingLedger {
  constructor(private readonly app: App) {}

  all(): Booking[] {
    const raw: unknown = this.app.loadLocalStorage(KEY);
    if (!isRecord(raw)) return [];
    const out: Booking[] = [];
    for (const [key, v] of Object.entries(raw)) {
      if (!isRecord(v)) continue;
      const { rowKey, minutes, messageId, fireAt, version, stale } = v;
      if (
        typeof rowKey === "string" &&
        typeof minutes === "number" &&
        typeof messageId === "string" &&
        typeof fireAt === "number" &&
        typeof version === "number"
      ) {
        out.push(stale === true ? { key, rowKey, minutes, messageId, fireAt, version, stale } : { key, rowKey, minutes, messageId, fireAt, version });
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

  /** False once the server answered a cancel with "unsupported" (M3 P9 / Task 8); device-local, reset for a new target. */
  cancelSupported(): boolean {
    return this.app.loadLocalStorage(CANCEL_UNSUPPORTED_KEY) !== true;
  }

  markCancelUnsupported(): void {
    if (this.cancelSupported()) this.app.saveLocalStorage(CANCEL_UNSUPPORTED_KEY, true);
  }

  /** Notes for which the server refused to cancel an edited push (final review 7); device-local, reset for a new target. */
  cancelRefused(path: string): boolean {
    return this.refusedPaths().includes(path);
  }

  markCancelRefused(path: string): void {
    const paths = this.refusedPaths();
    if (!paths.includes(path)) this.app.saveLocalStorage(CANCEL_REFUSED_KEY, [...paths, path]);
  }

  resetCancelSupport(): void {
    if (this.app.loadLocalStorage(CANCEL_UNSUPPORTED_KEY) !== null) this.app.saveLocalStorage(CANCEL_UNSUPPORTED_KEY, null);
    if (this.app.loadLocalStorage(CANCEL_REFUSED_KEY) !== null) this.app.saveLocalStorage(CANCEL_REFUSED_KEY, null);
  }

  private refusedPaths(): string[] {
    const raw: unknown = this.app.loadLocalStorage(CANCEL_REFUSED_KEY);
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  }

  private save(list: readonly Booking[]): void {
    if (!list.length) return this.clear();
    const out: Record<string, Omit<Booking, "key">> = {};
    for (const { key, rowKey, minutes, messageId, fireAt, version, stale } of list) {
      out[key] = stale ? { rowKey, minutes, messageId, fireAt, version, stale } : { rowKey, minutes, messageId, fireAt, version };
    }
    this.app.saveLocalStorage(KEY, out);
  }
}
