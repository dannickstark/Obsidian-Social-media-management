import type { IndexedVariant } from "../index/socialIndex";
import { decide, dueItems, type DueItem } from "./due";

export type ReconcileAction =
  | { kind: "check_needed"; path: string; channelId: string }
  | { kind: "dispatch"; item: DueItem }
  | { kind: "overdue"; item: DueItem };

/**
 * Startup (spec §5.1–5.2): a delivery left in `publishing`, or handed over without the platform id,
 * becomes check_needed and is never retried;
 * a past-due scheduled delivery goes to the Overdue tray unless it is within the grace or auto-post window.
 */
export function reconcilePlan(
  variants: readonly IndexedVariant[],
  now: number,
  defaultStagger: number,
  autoPostLateMs: number | null,
  /** A `publishing` this device's own run still has in flight is live, not stuck: it is left to that run. */
  inFlight: (path: string, channelId: string) => boolean = () => false,
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const v of variants) {
    for (const id of v.channels) {
      const d = v.deliveries[id];
      const stuck = d?.status === "publishing" || (d?.status === "handed_over" && !d.remoteId);
      if (stuck && !inFlight(v.path, id)) actions.push({ kind: "check_needed", path: v.path, channelId: id });
    }
  }
  for (const item of dueItems(variants, now, defaultStagger)) {
    actions.push({ kind: decide(item, autoPostLateMs) === "dispatch" ? "dispatch" : "overdue", item });
  }
  return actions;
}
