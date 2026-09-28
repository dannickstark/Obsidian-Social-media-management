import { DAY } from "../model/dates";
import type { ToolOutcome } from "./tools";

/**
 * Remembers what a write with an idempotency key produced (#75), so a retry after a timeout returns the first
 * result instead of creating a second note. In memory only: 24 hours, at most 500 keys, forgotten on reload.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, { at: number; result: Promise<ToolOutcome> }>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = DAY,
    private readonly max = 500,
  ) {}

  run(scope: string, key: string | undefined, fn: () => Promise<ToolOutcome>, stillValid: (o: ToolOutcome) => boolean = () => true): Promise<ToolOutcome> {
    if (!key) return fn();
    const id = `${scope}\u0000${key}`;
    this.prune();
    const hit = this.entries.get(id);
    if (!hit) return this.fresh(id, fn);
    return hit.result.then((o) => {
      if (!stillValid(o)) return this.fresh(id, fn);
      return o.ok ? { ok: true, data: { ...o.data, replayed: true } } : o;
    });
  }

  private fresh(id: string, fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const result = fn().then(
      (o) => {
        if (!o.ok) this.entries.delete(id);
        return o;
      },
      (e: unknown) => {
        this.entries.delete(id);
        throw e;
      },
    );
    this.entries.set(id, { at: this.now(), result });
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
