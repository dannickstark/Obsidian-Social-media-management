import type { Variant } from "../model/types";
import { cyrb53 } from "../util/hash";

/**
 * Variant fields that are post content. `sendDigest` covers each of them (media and mediaMeta through the
 * resolved media), so an approved or handed-over post is only sent while they are unchanged. An adapter may
 * read content only from these and from the job's text, items, body, media and featured image (M4 carry, #87).
 */
export const DIGESTED_VARIANT_FIELDS = ["platform", "title", "url", "media", "mediaMeta", "wordpress"] as const;

/** Variant fields that say who, where and when, not what: adapters may read them freely. */
export const IDENTITY_VARIANT_FIELDS = [
  "path",
  "campaignLink",
  "channels",
  "mode",
  "status",
  "scheduledAt",
  "staggerMinutes",
  "reminders",
  "deliveries",
  "invalidDeliveries",
  "review",
] as const;

type DigestedField = (typeof DIGESTED_VARIANT_FIELDS)[number];

/**
 * What a hand-over sent, as a short string (#66): computed by the index for every note and stored on the delivery
 * at hand-over. Built from the note itself (no file reads), so it covers the same content as `sendDigest`
 * except the resolved vault paths of the media.
 */
export function contentDigest(v: Pick<Variant, DigestedField>, body: string): string {
  const meta = (target: string) => [v.mediaMeta?.[target]?.alt ?? null, v.mediaMeta?.[target]?.focus ?? null];
  const featured = v.wordpress?.featuredImage;
  const parts = [v.platform, v.title ?? "", v.url ?? "", body, v.media.map((t) => [t, ...meta(t)]), v.wordpress ?? null, featured ? meta(featured) : null];
  return cyrb53(JSON.stringify(parts)).toString(36);
}
