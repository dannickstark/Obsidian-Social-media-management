import { DAY } from "../model/dates";
import { fail, type ToolOutcome } from "./tools";

export const KEY_REUSED = "This idempotency_key was already used with different arguments. Use a new key.";

/** JSON with object keys sorted at every level, so the same arguments always give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

interface Entry {
  at: number;
  /** Canonical arguments without the key (ruling I2). */
  args: string;
  result: Promise<ToolOutcome>;
}

/**
 * Remembers what a write with an idempotency key produced (#75), so a retry after a timeout returns the first
 * result instead of creating a second note. In memory only: 24 hours, at most 500 keys, forgotten on reload.
 * A failure is not kept unless it reports a note it already created (`data.path`), so a retry returns that note.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = DAY,
    private readonly max = 500,
  ) {}

  run(
    scope: string,
    key: string | undefined,
    args: Record<string, unknown>,
    fn: () => Promise<ToolOutcome>,
    stillValid: (o: ToolOutcome) => boolean = () => true,
  ): Promise<ToolOutcome> {
    if (!key) return fn();
    const id = `${scope}\u0000${key}`;
    const rest = { ...args };
    delete rest.idempotency_key;
    const sig = canonicalJson(rest);
    this.prune();
    const hit = this.entries.get(id);
    if (!hit) return this.fresh(id, sig, fn);
    if (hit.args !== sig) return Promise.resolve(fail(KEY_REUSED));
    return this.replay(id, hit, sig, fn, stillValid);
  }

  private replay(id: string, hit: Entry, sig: string, fn: () => Promise<ToolOutcome>, stillValid: (o: ToolOutcome) => boolean): Promise<ToolOutcome> {
    return hit.result.then((o) => {
      // Another replay already replaced this entry (e.g. its note was deleted): follow it, never run twice.
      const current = this.entries.get(id);
      if (current && current !== hit) return this.replay(id, current, sig, fn, stillValid);
      if (!stillValid(o)) return this.fresh(id, sig, fn);
      return o.ok ? { ok: true, data: { ...o.data, replayed: true } } : o;
    });
  }

  private fresh(id: string, args: string, fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const result = fn().then(
      (o) => {
        if (!o.ok && typeof o.data?.path !== "string") this.entries.delete(id);
        return o;
      },
      (e: unknown) => {
        this.entries.delete(id);
        throw e;
      },
    );
    this.entries.set(id, { at: this.now(), args, result });
    return result;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.entries) if (e.at < cutoff) this.entries.delete(id);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
