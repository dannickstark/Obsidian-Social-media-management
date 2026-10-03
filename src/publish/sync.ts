import type { IndexedVariant } from "../index/socialIndex";
import type { Delivery, Variant } from "../model/types";
import type { SyncChange } from "../platforms/types";
import type { MediaInfo } from "../platforms/types";
import { imageEmbeds } from "../platforms/wordpress/markdown";
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
 * at hand-over. The index supplies live fingerprints for generated originals and crops when it reads the note.
 */
export function contentDigest(v: Pick<Variant, DigestedField>, body: string, media: readonly MediaInfo[] = []): string {
  const meta = (target: string) => {
    const m = v.mediaMeta?.[target];
    return [m?.alt ?? null, m?.focus ?? null, m?.sourcePath ?? null, m?.cropPath ?? null, m?.cropRatio ?? null];
  };
  const featured = v.wordpress?.featuredImage;
  const fingerprint = (target: string) => {
    if (!v.mediaMeta?.[target]?.sourcePath) return null;
    const found = media.find((m) => m.target === target);
    return found ? [found.fingerprint ?? "missing", found.sourceFingerprint ?? "missing"] : null;
  };
  const bodyImages = v.platform === "wordpress" ? imageEmbeds(body).map((target) => [target, ...meta(target), fingerprint(target)]) : [];
  const parts = [v.platform, v.title ?? "", v.url ?? "", body, bodyImages, v.media.map((t) => [t, ...meta(t), fingerprint(t)]), v.wordpress ?? null, featured ? [...meta(featured), fingerprint(featured)] : null];
  return cyrb53(JSON.stringify(parts)).toString(36);
}

/** A handed-over channel compared with the platform's copy (#66). */
export interface SyncInfo {
  channelId: string;
  state: "in_sync" | "out_of_sync" | "unknown";
  content: boolean;
  time: boolean;
  remoteAt?: number;
  at?: number;
}

type SyncView = Pick<IndexedVariant, "channels" | "deliveries" | "invalidDeliveries" | "digest">;

/** Null unless the channel is handed over with the platform's id and its entry is readable. */
export function syncInfo(v: SyncView, channelId: string): SyncInfo | null {
  const d = v.deliveries[channelId];
  if (d?.status !== "handed_over" || !d.remoteId || v.invalidDeliveries?.includes(channelId)) return null;
  const content = d.digest !== undefined && v.digest !== undefined && d.digest !== v.digest;
  const time = d.remoteAt !== undefined && d.at !== undefined && d.at !== d.remoteAt;
  const state = content || time ? "out_of_sync" : d.digest === undefined && d.remoteAt === undefined ? "unknown" : "in_sync";
  return { channelId, state, content, time, ...(d.remoteAt !== undefined ? { remoteAt: d.remoteAt } : {}), ...(d.at !== undefined ? { at: d.at } : {}) };
}

export function handedOverChannels(v: SyncView): SyncInfo[] {
  return v.channels.map((id) => syncInfo(v, id)).filter((s): s is SyncInfo => s !== null);
}

export function outOfSync(v: SyncView, channelId?: string): boolean {
  return (channelId ? [channelId] : v.channels).some((id) => syncInfo(v, id)?.state === "out_of_sync");
}

/** What a push would change for this delivery; without a baseline, everything. */
export function syncChange(v: Pick<Variant, DigestedField>, body: string, d: Delivery, media: readonly MediaInfo[] = []): SyncChange {
  return { content: d.digest === undefined || d.digest !== contentDigest(v, body, media), time: d.remoteAt === undefined || d.at !== d.remoteAt };
}
