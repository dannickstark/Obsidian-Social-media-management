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
  awaiting_you: "is awaiting you to post manually",
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
  // An id with an unreadable delivery entry (typo'd status) is frozen: never write over it here either.
  const writable = ids.filter((id) => !fresh.invalidDeliveries?.includes(id));
  if (!writable.length) return { fields: { channels } };
  return { fields: { channels }, deliveries: Object.fromEntries(writable.map((id) => [id, { status } satisfies Delivery])) };
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
  if (fresh.invalidDeliveries?.includes(channel.id)) {
    return { refuse: `${channel.name}'s delivery status can't be read from the note, so it stays on this post until you fix it.` };
  }
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

/**
 * Replaces the channel list in one plan (MCP update_variant): removals follow planToggleChannel's rules (a channel
 * with history, or an unreadable entry, stays), additions inherit the post's status like withChannels.
 */
export function planSetChannels(
  fresh: Variant,
  desired: readonly Pick<Channel, "id" | "name" | "platform">[],
  nameOf: (id: string) => string,
): VariantUpdate | { refuse: string } {
  const wrong = desired.find((c) => c.platform !== fresh.platform);
  if (wrong) return { refuse: `${wrong.name} is not a ${PLATFORM_META[fresh.platform].label} channel.` };
  const ids = [...new Set(desired.map((c) => c.id))];
  const deliveries: Record<string, Delivery | null> = {};
  for (const id of fresh.channels.filter((c) => !ids.includes(c))) {
    if (fresh.invalidDeliveries?.includes(id)) return { refuse: `${nameOf(id)}'s delivery status can't be read from the note, so it stays on this post until you fix it.` };
    const d = fresh.deliveries[id];
    const why = d ? STAYS[d.status] : !hasRecords(fresh) && PUBLISHED.has(fresh.status) ? STAYS.published : undefined;
    if (why) return { refuse: `${nameOf(id)} ${why}, so it stays on this post.` };
    if (d) deliveries[id] = null;
  }
  const added = ids.filter((id) => !fresh.channels.includes(id));
  const channels = [...fresh.channels.filter((c) => ids.includes(c)), ...added];
  if (!channels.length && fresh.scheduledAt !== undefined && SCHEDULED.has(fresh.status)) {
    return { refuse: "A scheduled post needs at least one channel. Unschedule it first." };
  }
  if (added.length) Object.assign(deliveries, withChannels(fresh, added).deliveries ?? {});
  return Object.keys(deliveries).length ? { fields: { channels }, deliveries } : { fields: { channels } };
}
