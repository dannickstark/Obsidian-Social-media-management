import { expandRows, unreadableRow } from "../index/queries";
import type { IndexedCampaign, IndexedVariant } from "../index/socialIndex";
import { formatDateTime } from "../model/dates";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel } from "../model/types";
import { PLATFORM_DEFS } from "../platforms/registry";

export const iso = (ms: number | undefined): string | null => (ms === undefined ? null : formatDateTime(ms));

export function channelInfo(c: Channel, credential: "set" | "missing" | null) {
  return {
    id: c.id,
    platform: c.platform,
    name: c.name,
    kind: c.kind,
    handle: c.handle ?? null,
    method: c.method,
    default_time: c.defaultTime ?? null,
    default_reminders: c.defaultReminders ?? null,
    max_chars: c.maxChars ?? null,
    credential,
  };
}

/** One entry per listed channel: its row status and time, the live link or error, and whether it is frozen. */
export function channelRows(v: IndexedVariant, stagger: number, nameOf: (id: string) => string) {
  return expandRows([v], stagger)
    .filter((r) => r.channelId !== null)
    .map((r) => {
      const id = r.channelId as string;
      const d = v.deliveries[id];
      return {
        id,
        name: nameOf(id),
        status: r.status,
        at: iso(r.at),
        ...(d?.url ? { url: d.url } : {}),
        ...(d?.error ? { error: d.error } : {}),
        ...(unreadableRow(r) ? { frozen: true } : {}),
      };
    });
}

export function postSummary(v: IndexedVariant, stagger: number, nameOf: (id: string) => string) {
  return {
    path: v.path,
    title: v.displayTitle,
    platform: v.platform,
    campaign: v.campaignPath ?? null,
    status: v.status,
    scheduled_at: iso(v.scheduledAt),
    excerpt: v.excerpt,
    chars: v.bodyChars,
    ...(v.review ? { review: v.review } : {}),
    channels: channelRows(v, stagger, nameOf),
  };
}

export function campaignInfo(c: IndexedCampaign, progress: { published: number; total: number }, posts: number) {
  return {
    path: c.path,
    title: c.title,
    status: c.status,
    anchor_date: iso(c.anchorDate),
    link: c.link ?? null,
    posts,
    deliveries_published: progress.published,
    deliveries_total: progress.total,
  };
}

export function platformRules(p: Platform) {
  const def = PLATFORM_DEFS[p];
  const { limits, media, threads } = def.capabilities;
  return {
    platform: p,
    label: PLATFORM_META[p].label,
    channel_prefix: `${PLATFORM_META[p].prefix}/`,
    max_chars: limits.maxChars,
    counter: limits.counter,
    max_chars_with_media: limits.maxCharsWithMedia ?? null,
    fold_at: limits.foldAt ?? null,
    title_required: limits.titleRequired === true,
    title_max: limits.titleMax ?? null,
    link: limits.link,
    max_hashtags: limits.maxHashtags ?? null,
    threads,
    thread_separator: threads ? "a line containing only ---" : null,
    text_format: def.dialect,
    media: { max_count: media.maxCount, required: media.required, max_bytes: media.maxBytes, ratio: media.ratio ?? null },
    api: def.capabilities.api,
    native_schedule: def.capabilities.nativeSchedule,
  };
}
