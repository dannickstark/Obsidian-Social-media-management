export const PLATFORMS = [
  "linkedin",
  "x",
  "instagram",
  "facebook",
  "mastodon",
  "bluesky",
  "telegram",
  "discord",
  "hackernews",
  "indiehackers",
  "reddit",
  "whatsapp",
  "wordpress",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export interface PlatformMeta {
  readonly id: Platform;
  readonly label: string;
  /** Channel-id prefix, e.g. "li" in "li/acme-studio". */
  readonly prefix: string;
  /** Short text shown in badges. */
  readonly badge: string;
  /** Whether `---` in the body splits the post into a thread. */
  readonly threads: boolean;
}

export const PLATFORM_META: Readonly<Record<Platform, PlatformMeta>> = {
  linkedin: { id: "linkedin", label: "LinkedIn", prefix: "li", badge: "in", threads: false },
  x: { id: "x", label: "X", prefix: "x", badge: "X", threads: true },
  instagram: { id: "instagram", label: "Instagram", prefix: "ig", badge: "IG", threads: false },
  facebook: { id: "facebook", label: "Facebook", prefix: "fb", badge: "f", threads: false },
  mastodon: { id: "mastodon", label: "Mastodon", prefix: "ma", badge: "M", threads: true },
  bluesky: { id: "bluesky", label: "Bluesky", prefix: "bs", badge: "bs", threads: true },
  telegram: { id: "telegram", label: "Telegram", prefix: "tg", badge: "tg", threads: false },
  discord: { id: "discord", label: "Discord", prefix: "dc", badge: "dc", threads: false },
  hackernews: { id: "hackernews", label: "Hacker News", prefix: "hn", badge: "Y", threads: false },
  indiehackers: { id: "indiehackers", label: "Indie Hackers", prefix: "ih", badge: "IH", threads: false },
  reddit: { id: "reddit", label: "Reddit", prefix: "rd", badge: "r/", threads: false },
  whatsapp: { id: "whatsapp", label: "WhatsApp", prefix: "wa", badge: "wa", threads: false },
  wordpress: { id: "wordpress", label: "WordPress", prefix: "wp", badge: "WP", threads: false },
};

const BY_PREFIX = new Map(PLATFORMS.map((p) => [PLATFORM_META[p].prefix, p] as const));

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export function platformByPrefix(prefix: string): Platform | undefined {
  return BY_PREFIX.get(prefix);
}

export const CHANNEL_ID_RE = /^([a-z]{1,2})\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;

export function channelPlatform(id: string): Platform | undefined {
  const m = CHANNEL_ID_RE.exec(id);
  return m ? platformByPrefix(m[1] ?? "") : undefined;
}
