import { MINUTE } from "./dates";
import type { Delivery, DeliveryStatus, Variant, VariantStatus } from "./types";

/** Allowed delivery transitions (spec §5). `publishing` and `check_needed` never go back to a retryable state automatically. */
export const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  draft: ["ready", "scheduled", "skipped"],
  ready: ["draft", "scheduled", "skipped"],
  scheduled: ["draft", "ready", "handed_over", "publishing", "awaiting_you", "overdue", "skipped", "published"],
  handed_over: ["published", "failed", "scheduled", "check_needed"],
  publishing: ["published", "failed", "check_needed"],
  awaiting_you: ["published", "skipped", "scheduled", "overdue"],
  overdue: ["publishing", "awaiting_you", "scheduled", "skipped", "published"],
  failed: ["scheduled", "publishing", "skipped", "ready"],
  check_needed: ["published", "failed", "scheduled", "skipped"],
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

export function transition(
  d: Delivery,
  to: DeliveryStatus,
  patch: Partial<Omit<Delivery, "status">> = {},
): Delivery {
  if (!canTransition(d.status, to)) throw new IllegalTransitionError(d.status, to);
  return { ...d, ...patch, status: to };
}

const PENDING = new Set<DeliveryStatus>(["scheduled", "handed_over", "publishing", "awaiting_you"]);

export function rollupStatus(v: Pick<Variant, "status" | "channels" | "deliveries">): VariantStatus {
  // No delivery records yet: nothing to roll up, keep what the user wrote.
  if (!v.channels.some((c) => v.deliveries[c] !== undefined)) return v.status;
  const statuses = v.channels.map((c) => v.deliveries[c]?.status ?? "draft");
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
