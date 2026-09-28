import { deliveryTime, transition } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant } from "../model/types";
import type { OsmmSettings } from "../settings/settings";

export interface ScheduleRequest {
  at: number;
  reminders: number[];
}

export type SchedulePlan =
  | { fields: { scheduledAt: number; reminders: number[] }; deliveries: Record<string, Delivery>; frozen?: string[] }
  | { refuse: string };

/** Channels that keep their status and their time: done, in flight, or already on the platform. */
const KEEP = new Set<DeliveryStatus>(["published", "skipped", "publishing", "handed_over", "check_needed"]);
/** Ruling P2: a channel awaiting the user keeps its status (sticky); only its time moves with the post. */
const KEEP_STATUS = new Set<DeliveryStatus>(["awaiting_you"]);

export function planComposerSchedule(fresh: Variant, req: ScheduleRequest, defaultStagger: number): SchedulePlan {
  if (!fresh.channels.length) return { refuse: "Pick at least one channel before scheduling." };
  // An unreadable entry (typo'd status) is frozen: writing `scheduled` over it could publish it twice.
  const frozen = fresh.channels.filter((id) => fresh.invalidDeliveries?.includes(id));
  if (frozen.length === fresh.channels.length) return { refuse: "Every channel's delivery status can't be read from the note. Fix it before scheduling." };
  if (fresh.channels.some((id) => fresh.deliveries[id]?.status === "publishing")) return { refuse: "This post is being published right now." };
  const hasRecords = fresh.channels.some((id) => fresh.deliveries[id] !== undefined);
  if (!hasRecords && (fresh.status === "published" || fresh.status === "partial")) return { refuse: "This post was already published." };
  const deliveries: Record<string, Delivery> = {};
  for (const id of fresh.channels) {
    if (frozen.includes(id)) continue;
    const d = fresh.deliveries[id];
    if (d && KEEP.has(d.status)) {
      if (d.at === undefined) {
        const effective = deliveryTime(fresh, id, defaultStagger);
        if (effective !== undefined) deliveries[id] = { ...d, at: effective };
      }
      continue;
    }
    const base: Delivery = d ?? { status: "draft" };
    const next: Delivery = base.status === "scheduled" || KEEP_STATUS.has(base.status) ? { ...base } : transition(base, "scheduled");
    delete next.at;
    delete next.error;
    deliveries[id] = next;
  }
  return { fields: { scheduledAt: req.at, reminders: req.reminders }, deliveries, ...(frozen.length ? { frozen } : {}) };
}

export function scheduleNeeds(
  v: Pick<Variant, "channels" | "deliveries">,
  at: number,
  now: number,
): { past: boolean; handedOver: boolean; awaitingYou: boolean } {
  return {
    past: at < now,
    handedOver: v.channels.some((id) => v.deliveries[id]?.status === "handed_over"),
    awaitingYou: v.channels.some((id) => v.deliveries[id]?.status === "awaiting_you"),
  };
}

/** Static in v1: the first selected channel with a usual posting time. */
export function bestSlot(channels: readonly Channel[]): { time: string; channel: string } | null {
  const c = channels.find((x) => x.defaultTime);
  return c?.defaultTime ? { time: c.defaultTime, channel: c.name } : null;
}

export function reminderDefaults(v: Pick<Variant, "reminders">, channels: readonly Channel[], settings: Pick<OsmmSettings, "defaultReminders">): number[] {
  return [...(v.reminders ?? channels.find((c) => c.defaultReminders)?.defaultReminders ?? settings.defaultReminders)];
}
