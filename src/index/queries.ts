import { deliveryTime, inheritedStatus } from "../model/stateMachine";
import type { DeliveryStatus, Variant } from "../model/types";
import type { Platform } from "../model/platforms";
import type { IndexedVariant } from "./socialIndex";

export type RowStatus = DeliveryStatus | "idea";

/** One schedulable unit: a variant on one channel (or a variant without channels). */
export interface PostRow {
  key: string;
  variant: IndexedVariant;
  channelId: string | null;
  status: RowStatus;
  at?: number;
}

export interface RowFilter {
  platforms?: readonly Platform[];
  channelIds?: readonly string[];
  /** Campaign note paths; "" matches standalone posts. */
  campaignPaths?: readonly string[];
  statuses?: readonly RowStatus[];
}

/** Map stored variant status to row status when there are NO delivery records. */
function storedStatusToRow(status: IndexedVariant["status"]): RowStatus {
  switch (status) {
    case "idea":
    case "draft":
    case "ready":
    case "scheduled":
    case "published":
    case "overdue":
    case "skipped":
      return status;
    case "partial":
      return "scheduled";
    case "attention":
      return "failed";
  }
}

/** Status of a channel without a delivery record, when some listed channels do have records. */
function missingChannelStatus(v: Pick<IndexedVariant, "status" | "scheduledAt">): RowStatus {
  return v.status === "idea" ? "idea" : inheritedStatus(v);
}

/** The status one listed channel shows as a row: its record, else what it inherits (exactly what expandRows uses). */
export function channelRowStatus(v: Pick<IndexedVariant, "channels" | "deliveries" | "status" | "scheduledAt">, channelId: string): RowStatus {
  const own = v.deliveries[channelId];
  if (own) return own.status;
  const hasRecords = v.channels.some((c) => v.deliveries[c] !== undefined);
  return hasRecords ? missingChannelStatus(v) : storedStatusToRow(v.status);
}

export function expandRows(variants: readonly IndexedVariant[], defaultStagger: number): PostRow[] {
  const rows: PostRow[] = [];
  for (const v of variants) {
    if (v.channels.length === 0) {
      rows.push({ key: `${v.path}#`, variant: v, channelId: null, status: storedStatusToRow(v.status), at: v.scheduledAt });
      continue;
    }
    for (const id of v.channels) {
      rows.push({
        key: `${v.path}#${id}`,
        variant: v,
        channelId: id,
        status: channelRowStatus(v, id),
        at: deliveryTime(v, id, defaultStagger),
      });
    }
  }
  return rows;
}

const active = <T>(list: readonly T[] | undefined): list is readonly T[] => !!list && list.length > 0;

export function filterRows(rows: readonly PostRow[], f: RowFilter): PostRow[] {
  return rows.filter((r) => {
    if (active(f.platforms) && !f.platforms.includes(r.variant.platform)) return false;
    if (active(f.channelIds) && (r.channelId === null || !f.channelIds.includes(r.channelId))) return false;
    if (active(f.campaignPaths) && !f.campaignPaths.includes(r.variant.campaignPath ?? "")) return false;
    if (active(f.statuses) && !f.statuses.includes(r.status)) return false;
    return true;
  });
}

const byTime = (a: PostRow, b: PostRow) => (a.at ?? 0) - (b.at ?? 0) || a.key.localeCompare(b.key);

export function rowsBetween(rows: readonly PostRow[], from: number, to: number): PostRow[] {
  return rows.filter((r) => r.at !== undefined && r.at >= from && r.at < to).sort(byTime);
}

const OVERDUE_CANDIDATES = new Set<RowStatus>(["scheduled", "awaiting_you"]);

/** Rows with an unreadable delivery entry: never offered for posting (overdue tray, reminders). */
export function unreadableRow(r: Pick<PostRow, "variant" | "channelId">): boolean {
  return r.channelId !== null && (r.variant.invalidDeliveries?.includes(r.channelId) ?? false);
}

/**
 * A note the /social skill wrote while Obsidian was closed: nothing posts or reminds until the user
 * reviews it (#84). Fix round 1 (I1): any non-blank `review` value holds, fail-closed — only the
 * sidebar's Approve/Keep (or the MCP `schedule` tool, once the plugin has validated the note) clear it,
 * whatever it was set to. `parseVariant` separately warns when it is not exactly "claude".
 */
export function heldForReview(v: Pick<Variant, "review">): boolean {
  return v.review !== undefined;
}

/** Shown wherever an action on a held note is refused outside the sidebar's own Approve/Keep (#84 fix round 1). */
export const HELD_REFUSAL = "Approve it first in Written by Claude.";

const RESOLVED_DELIVERY = new Set<DeliveryStatus>(["published", "skipped"]);

/** Every channel of the post is already resolved (published or skipped): nothing is left to schedule or unschedule. */
export function nothingPending(v: Pick<Variant, "channels" | "deliveries">): boolean {
  return v.channels.length > 0 && v.channels.every((id) => RESOLVED_DELIVERY.has(v.deliveries[id]?.status ?? "draft"));
}

export function overdueRows(rows: readonly PostRow[], now: number): PostRow[] {
  return rows
    .filter((r) => !unreadableRow(r) && !heldForReview(r.variant))
    .filter((r) => r.status === "overdue" || (OVERDUE_CANDIDATES.has(r.status) && r.at !== undefined && r.at < now))
    .sort(byTime);
}

const UPCOMING = new Set<RowStatus>(["scheduled", "handed_over", "awaiting_you"]);

export function upcomingRows(rows: readonly PostRow[], now: number, horizonMs: number): PostRow[] {
  return rows
    .filter((r) => UPCOMING.has(r.status) && r.at !== undefined && r.at >= now && r.at < now + horizonMs)
    .sort(byTime);
}

export function unscheduledRows(rows: readonly PostRow[]): PostRow[] {
  return rows.filter((r) => r.at === undefined);
}

export function campaignProgress(
  variants: readonly IndexedVariant[],
  campaignPath: string,
): { published: number; total: number } {
  const rows = expandRows(
    variants.filter((v) => v.campaignPath === campaignPath),
    0,
  );
  return { published: rows.filter((r) => r.status === "published").length, total: rows.length };
}
