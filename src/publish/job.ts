import type { LoadedContent } from "../composer/content";
import type { Channel, Delivery, Variant } from "../model/types";
import { platformDef } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { DeliveryJob } from "../platforms/types";

/** Everything an adapter receives for one delivery, built one way for publish, schedule, update, cancel and lookup. */
export function deliveryJob(v: Variant, channel: Channel, delivery: Delivery, content: LoadedContent, secret: string | null): DeliveryJob {
  const def = platformDef(v.platform);
  const items = postItems(content.body, def);
  return {
    variant: v,
    channel,
    delivery,
    text: items.join("\n\n"),
    items,
    body: content.body,
    media: def.capabilities.media.maxCount > 0 ? content.media : [],
    ...(content.featured ? { featured: content.featured } : {}),
    secret,
  };
}
