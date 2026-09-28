import type { App } from "obsidian";
import { DAY } from "../model/dates";
import { isRecord } from "../model/frontmatter";

const KEY = "osmm-notified";
const KEEP_MS = 14 * DAY;

/** Device-local record of the reminders already shown, so each fires once per device, across restarts. */
export class NotifiedLedger {
  constructor(
    private readonly app: App,
    private readonly now: () => number,
  ) {}

  private read(): Record<string, number> {
    const raw: unknown = this.app.loadLocalStorage(KEY);
    const out: Record<string, number> = {};
    if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
    return out;
  }

  has(key: string): boolean {
    return key in this.read();
  }

  /** Records the key; false when it was already recorded. Entries older than 14 days are dropped. */
  add(key: string): boolean {
    const all = this.read();
    if (key in all) return false;
    const now = this.now();
    all[key] = now;
    for (const [k, t] of Object.entries(all)) if (now - t > KEEP_MS) delete all[k];
    this.app.saveLocalStorage(KEY, all);
    return true;
  }
}
