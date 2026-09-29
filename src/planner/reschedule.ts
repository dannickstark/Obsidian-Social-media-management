import type { PostRow, RowStatus } from "../index/queries";
import type { VariantPatch } from "../model/frontmatter";
import { deliveryTime, transition } from "../model/stateMachine";
import type { Delivery, DeliveryStatus } from "../model/types";

export type RescheduleTarget = { day: number } | { at: number };

export type ReschedulePlan =
  | { ok: true; patch: VariantPatch; previous: VariantPatch; needsConfirm: boolean; awaitingYou: boolean; newAt: number }
  | { ok: false; reason: string };

const FROZEN = new Set<RowStatus>(["published", "publishing", "skipped"]);
/** Sibling channels in these statuses keep their current effective time when the whole post shifts. */
const KEEP_TIME = new Set<DeliveryStatus>(["published", "skipped", "publishing"]);

function onDay(day: number, currentAt: number | undefined, defaultTime: string): number {
  const d = new Date(day);
  let h: number;
  let m: number;
  if (currentAt !== undefined) {
    const c = new Date(currentAt);
    h = c.getHours();
    m = c.getMinutes();
  } else {
    [h, m] = defaultTime.split(":").map(Number) as [number, number];
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

export function planReschedule(row: PostRow, target: RescheduleTarget, defaultTime = "09:00", defaultStagger = 0): ReschedulePlan {
  if (FROZEN.has(row.status)) {
    return {
      ok: false,
      reason: row.status === "publishing" ? "This post is being published right now." : "Published or skipped posts can't be rescheduled.",
    };
  }
  const v = row.variant;
  const newAt = "at" in target ? target.at : onDay(target.day, row.at, defaultTime);
  const deliveries: Record<string, Delivery> = { ...v.deliveries };
  const explicit = row.channelId !== null && v.deliveries[row.channelId]?.at !== undefined;

  let scheduledAt = v.scheduledAt;
  if (explicit) {
    deliveries[row.channelId!] = { ...deliveries[row.channelId!]!, at: newAt };
  } else {
    scheduledAt = row.at === undefined || v.scheduledAt === undefined ? newAt : v.scheduledAt + (newAt - row.at);
    // The whole post is shifting: sibling channels that are already published/skipped/publishing and
    // have no explicit time must keep their current effective time, not silently follow the shift.
    for (const id of v.channels) {
      if (id === row.channelId) continue;
      const d = v.deliveries[id];
      if (d && KEEP_TIME.has(d.status) && d.at === undefined) {
        const effective = deliveryTime(v, id, defaultStagger);
        if (effective !== undefined) deliveries[id] = { ...d, at: effective };
      }
    }
  }

  const affected = explicit ? [row.channelId!] : v.channels;
  for (const id of affected) {
    const d = deliveries[id];
    if (d?.status === "overdue") deliveries[id] = transition(d, "scheduled");
  }
  // Only deliveries that actually move need confirming: a sibling with its own explicit time stays put.
  const moving = explicit ? affected : affected.filter((id) => id === row.channelId || v.deliveries[id]?.at === undefined);
  // Ruling P2: a delivery already awaiting the user is sticky, same as one handed over — moving it needs confirmation.
  const awaitingYou = moving.some((id) => deliveries[id]?.status === "awaiting_you");
  const needsConfirm = awaitingYou || moving.some((id) => deliveries[id]?.status === "handed_over");

  return {
    ok: true,
    newAt,
    needsConfirm,
    awaitingYou,
    previous: { scheduledAt: v.scheduledAt, deliveries: Object.fromEntries(Object.entries(v.deliveries).map(([k, d]) => [k, { ...d }])) },
    patch: { scheduledAt, deliveries },
  };
}
