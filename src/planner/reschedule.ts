import type { PostRow, RowStatus } from "../index/queries";
import type { VariantPatch } from "../model/frontmatter";
import { transition } from "../model/stateMachine";
import type { Delivery } from "../model/types";

export type RescheduleTarget = { day: number } | { at: number };

export type ReschedulePlan =
  | { ok: true; patch: VariantPatch; previous: VariantPatch; needsConfirm: boolean; newAt: number }
  | { ok: false; reason: string };

const FROZEN = new Set<RowStatus>(["published", "publishing", "skipped"]);

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

export function planReschedule(row: PostRow, target: RescheduleTarget, defaultTime = "09:00"): ReschedulePlan {
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
  if (explicit) deliveries[row.channelId!] = { ...deliveries[row.channelId!]!, at: newAt };
  else scheduledAt = row.at === undefined || v.scheduledAt === undefined ? newAt : v.scheduledAt + (newAt - row.at);

  const affected = explicit ? [row.channelId!] : v.channels;
  for (const id of affected) {
    const d = deliveries[id];
    if (d?.status === "overdue") deliveries[id] = transition(d, "scheduled");
  }
  const needsConfirm = affected.some((id) => deliveries[id]?.status === "handed_over");

  return {
    ok: true,
    newAt,
    needsConfirm,
    previous: { scheduledAt: v.scheduledAt, deliveries: v.deliveries },
    patch: { scheduledAt, deliveries },
  };
}
