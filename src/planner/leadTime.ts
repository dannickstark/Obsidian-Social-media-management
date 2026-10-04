import { channelRowStatus } from "../index/queries";
import { MINUTE } from "../model/dates";
import { deliveryTime } from "../model/stateMachine";
import type { Variant } from "../model/types";

/** A post Claude schedules goes out without a second question, so the user gets this long to step in. */
export const MIN_SCHEDULE_LEAD_MS = 10 * MINUTE;

export const GOES_OUT_SOON = "This post goes out in less than 10 minutes; unschedule it first or ask the user.";

/** A scheduled channel's effective time (pinned or post time plus stagger) is inside the editing lead time. */
export function goesOutSoon(
  v: Pick<Variant, "channels" | "deliveries" | "status" | "scheduledAt" | "staggerMinutes">,
  now: number,
  stagger: number,
  channelIds: readonly string[] = v.channels,
): boolean {
  return channelIds.some((id) => channelRowStatus(v, id) === "scheduled" && (deliveryTime(v, id, stagger) ?? Infinity) < now + MIN_SCHEDULE_LEAD_MS);
}
