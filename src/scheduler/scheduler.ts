import type { SocialIndex } from "../index/socialIndex";
import type { OsmmSettings } from "../settings/settings";
import { decide, dueItems, type DueItem } from "./due";

export interface SchedulerPort {
  dispatch(item: DueItem): Promise<void>;
  markOverdue(item: DueItem): Promise<void>;
}

export interface SchedulerDeps {
  index: SocialIndex;
  settings(): OsmmSettings;
  now(): number;
  /**
   * Only the publisher device runs deliveries (spec §4.3). The publisher-device setting arrives in
   * M3 (#26); until then the plugin passes `() => true`.
   */
  isPublisher(): boolean;
  /** Late deliveries younger than this are still posted (the optional auto-post setting); null when off. */
  autoPostLateMs(): number | null;
  publish: SchedulerPort;
  /** Runs on every tick on every device, before the publisher check (desktop reminders). */
  onTick?(now: number, previous: number | null): void | Promise<void>;
  warn(message: string): void;
  intervalMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface TickResult {
  dispatched: string[];
  overdue: string[];
}

/** The 30-second loop (spec §4). A wake from sleep is simply a late tick: `decide` turns stale items into overdue ones. */
export class Scheduler {
  private handle: unknown = null;
  private lastTick: number | null = null;
  private running = false;
  private readonly handled = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  private get timers() {
    return (
      this.deps.timers ?? {
        set: (fn: () => void, ms: number) => window.setInterval(fn, ms),
        clear: (handle: unknown) => window.clearInterval(handle as number),
      }
    );
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.timers.set(() => void this.tick(), this.deps.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { dispatched: [], overdue: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.deps.now();
      const previous = this.lastTick;
      this.lastTick = now;
      await this.deps.onTick?.(now, previous);
      if (!this.deps.isPublisher()) return result;
      this.warnUnreadable();
      const stagger = this.deps.settings().defaultStaggerMinutes;
      const lateMs = this.deps.autoPostLateMs();
      for (const item of dueItems(this.deps.index.variants(), now, stagger)) {
        if (this.handled.has(item.key)) continue;
        this.handled.add(item.key);
        try {
          if (decide(item, lateMs) === "dispatch") {
            result.dispatched.push(item.key);
            await this.deps.publish.dispatch(item);
          } else {
            result.overdue.push(item.key);
            await this.deps.publish.markOverdue(item);
          }
        } catch (e) {
          this.deps.warn(`Could not run ${item.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private warnUnreadable(): void {
    for (const v of this.deps.index.variants()) {
      for (const id of v.invalidDeliveries ?? []) {
        if (!v.channels.includes(id)) continue;
        const key = `${v.path}#${id}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        this.deps.warn(`${v.file.basename}: the delivery status of ${id} can't be read, so it won't be published. Fix it in the note.`);
      }
    }
  }
}
