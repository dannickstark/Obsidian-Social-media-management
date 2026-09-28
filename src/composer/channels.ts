import { PLATFORM_META } from "../model/platforms";
import { inheritedStatus } from "../model/stateMachine";
import type { Channel, Delivery, DeliveryStatus, Variant, VariantStatus } from "../model/types";
import type { VariantUpdate } from "../model/writer";

/** Channels in these states are part of the post's history and cannot be deselected. */
const STAYS: Partial<Record<DeliveryStatus, string>> = {
  published: "was already published",
  publishing: "is being published right now",
  handed_over: "was handed over to the platform",
  check_needed: "needs a check after an interrupted publish",
};
const PUBLISHED = new Set<VariantStatus>(["published", "partial"]);
const SCHEDULED = new Set<VariantStatus>(["scheduled", "partial", "overdue", "attention"]);

function hasRecords(v: Pick<Variant, "channels" | "deliveries">): boolean {
  return v.channels.some((c) => v.deliveries[c] !== undefined);
}

function withChannels(fresh: Variant, ids: readonly string[]): VariantUpdate {
  const channels = [...fresh.channels, ...ids];
  if (!hasRecords(fresh)) return { fields: { channels } };
  const status = inheritedStatus(fresh);
  return { fields: { channels }, deliveries: Object.fromEntries(ids.map((id) => [id, { status } satisfies Delivery])) };
}

export function planToggleChannel(
  fresh: Variant,
  channel: Pick<Channel, "id" | "name" | "platform">,
  on: boolean,
): VariantUpdate | { refuse: string } {
  const has = fresh.channels.includes(channel.id);
  if (on) {
    if (has) return {};
    if (channel.platform !== fresh.platform) return { refuse: `${channel.name} is not a ${PLATFORM_META[fresh.platform].label} channel.` };
    return withChannels(fresh, [channel.id]);
  }
  if (!has) return {};
  const d = fresh.deliveries[channel.id];
  const why = d ? STAYS[d.status] : !hasRecords(fresh) && PUBLISHED.has(fresh.status) ? STAYS.published : undefined;
  if (why) return { refuse: `${channel.name} ${why}, so it stays on this post.` };
  const channels = fresh.channels.filter((c) => c !== channel.id);
  if (!channels.length && fresh.scheduledAt !== undefined && SCHEDULED.has(fresh.status)) {
    return { refuse: "A scheduled post needs at least one channel. Unschedule it first." };
  }
  return d ? { fields: { channels }, deliveries: { [channel.id]: null } } : { fields: { channels } };
}

export function planSelectGroup(fresh: Variant, channels: readonly Pick<Channel, "id" | "platform">[]): VariantUpdate {
  const ids = channels.filter((c) => c.platform === fresh.platform && !fresh.channels.includes(c.id)).map((c) => c.id);
  return ids.length ? withChannels(fresh, ids) : {};
}
