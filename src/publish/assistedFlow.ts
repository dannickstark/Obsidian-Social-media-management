import { deliveryTime } from "../model/stateMachine";
import type { DeliveryStatus, Variant } from "../model/types";
import { effectiveDelivery } from "./eligibility";

/** Channels that no longer need posting. */
const DONE = new Set<DeliveryStatus>(["published", "skipped", "publishing", "handed_over", "check_needed"]);

/** Channels of a post that still need posting, in stagger order (earliest first). */
export function assistedQueue(v: Variant, defaultStagger: number, only?: readonly string[]): string[] {
  return v.channels
    .filter((id) => !only || only.includes(id))
    .filter((id) => {
      const d = effectiveDelivery(v, id);
      return d !== null && !DONE.has(d.status);
    })
    .sort((a, b) => (deliveryTime(v, a, defaultStagger) ?? 0) - (deliveryTime(v, b, defaultStagger) ?? 0) || v.channels.indexOf(a) - v.channels.indexOf(b));
}
