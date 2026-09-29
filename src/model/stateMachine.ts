import { MINUTE } from "./dates";
import type { Delivery, DeliveryStatus, Variant, VariantStatus } from "./types";

/** Allowed delivery transitions (spec §5). `publishing` and `check_needed` never go back to a retryable state automatically. */
export const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  draft: ["ready", "scheduled", "skipped"],
  ready: ["draft", "scheduled", "skipped"],
  scheduled: ["draft", "ready", "handed_over", "publishing", "awaiting_you", "overdue", "skipped"],
  handed_over: ["published", "failed", "scheduled", "check_needed"],
  publishing: ["published", "failed", "check_needed"],
  awaiting_you: ["published", "skipped", "scheduled", "overdue"],
  overdue: ["publishing", "awaiting_you", "scheduled", "skipped", "published"],
  failed: ["scheduled", "publishing", "skipped", "ready"],
  // M5: a lookup that finds an interrupted hand-over on the platform's schedule returns it to handed_over
  // (only with a hand-over baseline, see `transition`).
  check_needed: ["published", "failed", "scheduled", "skipped", "handed_over"],
  published: [],
  skipped: ["ready", "scheduled"],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`Illegal delivery transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** M5 P17: statuses that end a send or re-plan the delivery; entering one drops the send key. */
const CLEARS_SEND_KEY = new Set<DeliveryStatus>(["published", "draft", "ready", "scheduled"]);

export function transition(
  d: Delivery,
  to: DeliveryStatus,
  patch: Partial<Omit<Delivery, "status">> = {},
): Delivery {
  if (!canTransition(d.status, to)) throw new IllegalTransitionError(d.status, to);
  // M5 P11: only a delivery with a hand-over baseline (remoteAt) goes back to handed_over; an interrupted
  // immediate publish that a lookup finds on someone's schedule stays check_needed.
  if (d.status === "check_needed" && to === "handed_over" && ("remoteAt" in patch ? patch.remoteAt : d.remoteAt) === undefined) {
    throw new IllegalTransitionError(d.status, to);
  }
  const next: Delivery = { ...d, ...patch, status: to };
  // M5 P17: the send key belongs to one send. It is kept while that send is outstanding (publishing, failed and
  // retried, check_needed) and dropped once it is published or the delivery is re-planned.
  if (CLEARS_SEND_KEY.has(to) && !("sendAt" in patch)) delete next.sendAt;
  return next;
}

const PENDING = new Set<DeliveryStatus>(["scheduled", "handed_over", "publishing", "awaiting_you"]);

/** Status that a listed channel WITHOUT a delivery record takes, derived from the stored variant status. */
export function inheritedStatus(v: Pick<Variant, "status" | "scheduledAt">): DeliveryStatus {
  switch (v.status) {
    case "idea":
    case "draft":
      return "draft";
    case "ready":
      return "ready";
    case "scheduled":
    case "partial":
    case "overdue":
    case "attention":
    case "published":
    case "skipped":
      return v.scheduledAt !== undefined ? "scheduled" : "draft";
  }
}

export function rollupStatus(v: Pick<Variant, "status" | "scheduledAt" | "channels" | "deliveries">): VariantStatus {
  // No delivery records for listed channels yet: nothing to roll up, keep what the user wrote.
  if (!v.channels.some((c) => v.deliveries[c] !== undefined)) return v.status;
  const missing = inheritedStatus(v);
  const statuses = v.channels.map((c) => v.deliveries[c]?.status ?? missing);
  if (statuses.some((s) => s === "failed" || s === "check_needed")) return "attention";
  if (statuses.some((s) => s === "overdue")) return "overdue";
  const published = statuses.filter((s) => s === "published").length;
  const skipped = statuses.filter((s) => s === "skipped").length;
  if (published + skipped === statuses.length) return published > 0 ? "published" : "skipped";
  if (published > 0) return "partial";
  if (statuses.some((s) => PENDING.has(s))) return "scheduled";
  if (statuses.every((s) => s === "ready")) return "ready";
  return v.status === "idea" ? "idea" : "draft";
}

export function deliveryTime(
  v: Pick<Variant, "scheduledAt" | "channels" | "staggerMinutes" | "deliveries">,
  channelId: string,
  defaultStagger: number,
): number | undefined {
  const explicit = v.deliveries[channelId]?.at;
  if (explicit !== undefined) return explicit;
  if (v.scheduledAt === undefined) return undefined;
  const index = Math.max(0, v.channels.indexOf(channelId));
  return v.scheduledAt + index * (v.staggerMinutes ?? defaultStagger) * MINUTE;
}

/**
 * Times never move without an explicit schedule call (M4 Task 6 cross-task ruling). For each channel
 * listed both before and in `next` that is scheduled, has no own time and whose effective time would
 * change (its position or the stagger changes), its delivery with the current time pinned. Unreadable
 * entries are never written.
 */
export function pinScheduledTimes(
  before: Pick<Variant, "status" | "scheduledAt" | "channels" | "staggerMinutes" | "deliveries" | "invalidDeliveries">,
  next: Partial<Pick<Variant, "channels" | "staggerMinutes">>,
  defaultStagger: number,
): Record<string, Delivery> {
  const after = { ...before, ...next };
  const hasRecords = before.channels.some((id) => before.deliveries[id] !== undefined);
  const out: Record<string, Delivery> = {};
  for (const id of after.channels) {
    if (!before.channels.includes(id) || before.invalidDeliveries?.includes(id)) continue;
    const d = before.deliveries[id];
    if (d?.at !== undefined) continue;
    const scheduled = d
      ? d.status === "scheduled"
      : hasRecords
        ? inheritedStatus(before) === "scheduled"
        : before.status === "scheduled" || before.status === "partial";
    if (!scheduled) continue;
    const was = deliveryTime(before, id, defaultStagger);
    if (was !== undefined && was !== deliveryTime(after, id, defaultStagger)) out[id] = { ...(d ?? { status: "scheduled" }), at: was };
  }
  return out;
}
