import type { LoadedContent } from "../composer/content";
import type { Platform } from "../model/platforms";
import type { Channel, Variant } from "../model/types";
import { assisted as bluesky } from "../platforms/bluesky/assisted";
import { assisted as discord } from "../platforms/discord/assisted";
import { assisted as facebook } from "../platforms/facebook/assisted";
import { assisted as hackernews } from "../platforms/hackernews/assisted";
import { assisted as indiehackers } from "../platforms/indiehackers/assisted";
import { assisted as instagram } from "../platforms/instagram/assisted";
import { assisted as linkedin } from "../platforms/linkedin/assisted";
import { assisted as mastodon } from "../platforms/mastodon/assisted";
import { assisted as reddit } from "../platforms/reddit/assisted";
import { assisted as telegram } from "../platforms/telegram/assisted";
import { assisted as whatsapp } from "../platforms/whatsapp/assisted";
import { assisted as wordpress } from "../platforms/wordpress/assisted";
import { assisted as x } from "../platforms/x/assisted";
import { platformDef } from "../platforms/registry";
import { postItems } from "../platforms/text";
import type { AssistedBuilder, AssistedJob, AssistedTarget } from "../platforms/types";

export const ASSISTED: Readonly<Record<Platform, AssistedBuilder>> = {
  linkedin,
  x,
  instagram,
  facebook,
  mastodon,
  bluesky,
  telegram,
  discord,
  hackernews,
  indiehackers,
  reddit,
  whatsapp,
  wordpress,
};

export function assistedJob(variant: Variant, channel: Channel, content: Pick<LoadedContent, "body" | "media">): AssistedJob {
  const def = platformDef(variant.platform);
  const items = postItems(content.body, def);
  return { variant, channel, items, text: items.join("\n\n"), media: def.capabilities.media.maxCount > 0 ? content.media : [] };
}

export function assistedTarget(job: AssistedJob): AssistedTarget {
  const target = ASSISTED[job.variant.platform](job);
  const images = target.clipboard.filter((c) => "imagePath" in c).length;
  if (!images) return target;
  return { ...target, hint: `${target.hint} Then add the ${images === 1 ? "image" : `${images} images`}.` };
}
