import { expandRows, heldForReview } from "../index/queries";
import type { IndexedVariant } from "../index/socialIndex";
import { MINUTE } from "../model/dates";
import { unreadable } from "../publish/eligibility";

/** A delivery at most this late is still posted "on time": the 30-second tick plus a margin. */
export const GRACE_MS = 2 * MINUTE;

export interface DueItem {
  /** Row key plus due time: a rescheduled delivery is a new item. */
  key: string;
  path: string;
  channelId: string;
  at: number;
  late: number;
}

/** Scheduled deliveries whose time has come (stagger included), oldest first. Unreadable entries never are. */
export function dueItems(variants: readonly IndexedVariant[], now: number, defaultStagger: number): DueItem[] {
  const out: DueItem[] = [];
  for (const r of expandRows(variants, defaultStagger)) {
    if (r.channelId === null || r.status !== "scheduled" || r.at === undefined || r.at > now) continue;
    if (unreadable(r.variant, r.channelId)) continue;
    if (heldForReview(r.variant)) continue;
    out.push({ key: `${r.key}@${r.at}`, path: r.variant.path, channelId: r.channelId, at: r.at, late: now - r.at });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** Spec §5.2: no silent late posting. Only the grace period, or the optional auto-post window, may still post. */
export function decide(item: Pick<DueItem, "late">, autoPostLateMs: number | null): "dispatch" | "overdue" {
  if (item.late <= GRACE_MS) return "dispatch";
  if (autoPostLateMs !== null && item.late <= autoPostLateMs) return "dispatch";
  return "overdue";
}
