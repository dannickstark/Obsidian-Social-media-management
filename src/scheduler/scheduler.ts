import type { SocialIndex } from "../index/socialIndex";
import type { OsmmSettings } from "../settings/settings";
import { decide, dueItems, type DueItem } from "./due";
import { reconcilePlan } from "./reconcile";

export interface SchedulerPort {
  dispatch(item: DueItem): Promise<void>;
  markOverdue(item: DueItem): Promise<void>;
  /** `publishing → check_needed`; false when the delivery changed meanwhile. */
  markCheckNeeded(path: string, channelId: string): Promise<boolean>;
  /** Asks the platform whether an interrupted publish went out, where the adapter can tell. */
  resolveCheck(path: string, channelId: string): Promise<void>;
}

export interface SchedulerDeps {
  index: SocialIndex;
  settings(): OsmmSettings;
  now(): number;
  /** Only the publisher device runs deliveries (spec §4.3); the plugin reads `PublisherService.isPublisher()`. */
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

export interface ReconcileSummary {
  checkNeeded: number;
  overdue: number;
  dispatched: number;
}

/** The 30-second loop (spec §4). A wake from sleep is simply a late tick: `decide` turns stale items into overdue ones. */
export class Scheduler {
  private handle: unknown = null;
  private lastTick: number | null = null;
  private running = false;
  /** Set by reconcile(): a tick before the startup reconcile is a no-op (a stuck `publishing` is checked first). */
  private ready = false;
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
    if (this.running || !this.ready) return result;
    this.running = true;
    try {
      const now = this.deps.now();
      const previous = this.lastTick;
      this.lastTick = now;
      try {
        await this.deps.onTick?.(now, previous);
      } catch (e) {
        this.deps.warn(e instanceof Error ? e.message : String(e));
      }
      // Re-checked after onTick: becamePublisher() may have closed the gate while it ran (M3 P2).
      if (!this.ready || !this.deps.isPublisher()) return result;
      this.warnUnreadable();
      const stagger = this.deps.settings().defaultStaggerMinutes;
      const lateMs = this.deps.autoPostLateMs();
      for (const item of dueItems(this.deps.index.variants(), now, stagger)) {
        // The role can move to another device mid-loop (a synced takeover): stop at once.
        if (!this.deps.isPublisher()) break;
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

  /** Runs once at startup, before the loop (publisher only); ticks are no-ops until it has run. */
  async reconcile(): Promise<ReconcileSummary> {
    try {
      return await this.reconcileOnce();
    } finally {
      this.ready = true;
    }
  }

  /**
   * This device just became the publisher after start-up: close the ready gate and run the startup
   * reconcile it skipped as a non-publisher, so a stuck `publishing` becomes check_needed before any dispatch.
   */
  becamePublisher(): Promise<ReconcileSummary> {
    this.ready = false;
    return this.reconcile();
  }

  private async reconcileOnce(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { checkNeeded: 0, overdue: 0, dispatched: 0 };
    if (!this.deps.isPublisher()) return summary;
    const plan = reconcilePlan(this.deps.index.variants(), this.deps.now(), this.deps.settings().defaultStaggerMinutes, this.deps.autoPostLateMs());
    for (const action of plan) {
      if (!this.deps.isPublisher()) break;
      try {
        if (action.kind === "check_needed") {
          if (await this.deps.publish.markCheckNeeded(action.path, action.channelId)) {
            summary.checkNeeded++;
            await this.deps.publish.resolveCheck(action.path, action.channelId);
          }
          continue;
        }
        if (this.handled.has(action.item.key)) continue;
        this.handled.add(action.item.key);
        if (action.kind === "dispatch") {
          summary.dispatched++;
          await this.deps.publish.dispatch(action.item);
        } else {
          summary.overdue++;
          await this.deps.publish.markOverdue(action.item);
        }
      } catch (e) {
        this.deps.warn(`Could not check ${action.kind === "check_needed" ? action.path : action.item.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return summary;
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
