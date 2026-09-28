import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel } from "../model/types";
import { hostOf, mastodonInstance } from "../platforms/share";

const HOSTS: Readonly<Record<Platform, readonly string[] | null>> = {
  linkedin: ["linkedin.com", "lnkd.in"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.com", "fb.watch"],
  mastodon: null,
  bluesky: ["bsky.app"],
  telegram: ["t.me", "telegram.me"],
  discord: ["discord.com", "discordapp.com"],
  hackernews: ["news.ycombinator.com"],
  indiehackers: ["indiehackers.com"],
  reddit: ["reddit.com", "redd.it"],
  whatsapp: ["whatsapp.com", "wa.me"],
  wordpress: null,
};

const NOT_A_LINK = "Paste the full link to the post, starting with https://";

/** Hosts a live link may point to; null when any host is fine (Mastodon instance or WordPress site unknown). */
export function expectedHosts(platform: Platform, channel?: Pick<Channel, "handle">): readonly string[] | null {
  if (platform === "mastodon") {
    const instance = mastodonInstance(channel?.handle);
    return instance ? [instance] : null;
  }
  if (platform === "wordpress") {
    const site = hostOf(channel?.handle);
    return site ? [site] : null;
  }
  return HOSTS[platform];
}

export type LiveUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export function validateLiveUrl(platform: Platform, raw: string, channel?: Pick<Channel, "handle">): LiveUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: NOT_A_LINK };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) return { ok: false, reason: NOT_A_LINK };
  const hosts = expectedHosts(platform, channel);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, reason: `That isn't a ${PLATFORM_META[platform].label} link (expected ${hosts[0]}).` };
  }
  return { ok: true, url: url.href };
}
