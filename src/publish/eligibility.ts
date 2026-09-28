import { channelRowStatus } from "../index/queries";
import type { Delivery, Variant } from "../model/types";

export function unreadable(v: Pick<Variant, "invalidDeliveries">, channelId: string): boolean {
  return v.invalidDeliveries?.includes(channelId) ?? false;
}

/**
 * The delivery a listed channel effectively has: its own record, or the status its row shows.
 * Null when it must not be touched: not listed, unreadable (frozen), or the post is still an idea.
 */
export function effectiveDelivery(v: Variant, channelId: string): Delivery | null {
  if (!v.channels.includes(channelId) || unreadable(v, channelId)) return null;
  const status = channelRowStatus(v, channelId);
  if (status === "idea") return null;
  return v.deliveries[channelId] ?? { status };
}
