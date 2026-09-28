import type { IndexedVariant } from "../index/socialIndex";
import { canTransition, transition } from "../model/stateMachine";
import type { Delivery, DeliveryStatus, Variant, VariantStatus } from "../model/types";

export const BOARD_COLUMNS = ["idea", "draft", "ready", "scheduled", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
type EditableStatus = "idea" | "draft" | "ready";

export type BoardMove =
  | { kind: "setStatus"; status: EditableStatus }
  | { kind: "schedule" }
  | { kind: "unschedule"; status: EditableStatus };

export function columnOf(status: VariantStatus): BoardColumn | null {
  switch (status) {
    case "idea":
    case "draft":
    case "ready":
      return status;
    case "scheduled":
    case "partial":
    case "overdue":
    case "attention":
      return "scheduled";
    case "published":
      return "published";
    case "skipped":
      return null;
  }
}

const SAFE_TO_UNSCHEDULE = new Set<DeliveryStatus>(["draft", "ready", "scheduled", "overdue", "skipped"]);

export function planBoardMove(
  v: IndexedVariant,
  to: BoardColumn,
): { ok: true; move: BoardMove } | { ok: false; reason: string } {
  const from = columnOf(v.status);
  if (from === to) return { ok: false, reason: "The post is already in this column." };
  if (from === "published") return { ok: false, reason: "Published posts stay published." };
  if (to === "published") return { ok: false, reason: "Posts move to Published when they are posted, not by dragging." };
  if (to === "scheduled") {
    return v.channels.length ? { ok: true, move: { kind: "schedule" } } : { ok: false, reason: "Pick at least one channel before scheduling." };
  }
  if (from === "scheduled") {
    const blocked = Object.values(v.deliveries).some((d) => !SAFE_TO_UNSCHEDULE.has(d.status));
    if (blocked) return { ok: false, reason: "Some channels were already handed over or published. Unschedule the remaining ones from the post itself." };
    return { ok: true, move: { kind: "unschedule", status: to } };
  }
  return { ok: true, move: { kind: "setStatus", status: to } };
}

export function scheduleDeliveries(v: Pick<Variant, "channels" | "deliveries">): Record<string, Delivery> {
  const out: Record<string, Delivery> = { ...v.deliveries };
  for (const id of v.channels) {
    const current = out[id] ?? { status: "draft" as const };
    if (canTransition(current.status, "scheduled")) out[id] = transition(current, "scheduled");
  }
  return out;
}

export function unscheduleDeliveries(v: Pick<Variant, "deliveries">, to: "draft" | "ready"): Record<string, Delivery> {
  const out: Record<string, Delivery> = {};
  for (const [id, d] of Object.entries(v.deliveries)) {
    out[id] = d.status === "scheduled" || d.status === "overdue" ? transition(d.status === "overdue" ? transition(d, "scheduled") : d, to) : d;
  }
  return out;
}

export function defaultScheduleTime(now: number, v: Pick<Variant, "scheduledAt">, defaultTime = "09:00"): number {
  if (v.scheduledAt !== undefined && v.scheduledAt >= now) return v.scheduledAt;
  const [h, m] = defaultTime.split(":").map(Number) as [number, number];
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
}
