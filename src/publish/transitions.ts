import { canTransition, transition } from "../model/stateMachine";
import type { Delivery } from "../model/types";

type Patch = Partial<Omit<Delivery, "status">>;

/** The assisted path of spec §5: into `awaiting_you`, via `scheduled` when needed. Null when not allowed. */
export function toAwaiting(d: Delivery): Delivery | null {
  switch (d.status) {
    case "awaiting_you":
      return d;
    case "scheduled":
    case "overdue":
      return transition(d, "awaiting_you");
    case "draft":
    case "ready":
    case "failed":
    case "skipped":
      return transition(transition(d, "scheduled"), "awaiting_you");
    default:
      return null;
  }
}

/** `scheduled → published` is illegal, so an assisted post passes through `awaiting_you`. */
export function toPublished(d: Delivery, patch: Patch = {}): Delivery | null {
  if (d.status === "check_needed" || d.status === "handed_over") return transition(d, "published", patch);
  const waiting = toAwaiting(d);
  return waiting ? transition(waiting, "published", patch) : null;
}

export function toSkipped(d: Delivery, reason?: string): Delivery | null {
  if (!canTransition(d.status, "skipped")) return null;
  return transition(d, "skipped", reason ? { reason } : {});
}
