import type { z } from "zod";
import type { Platform } from "./platforms";
import type {
  CHANNEL_KINDS,
  DELIVERY_STATUSES,
  POST_MODES,
  PUBLISH_METHODS,
  VARIANT_STATUSES,
  zChannel,
  zChannelGroup,
} from "./schemas";

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type VariantStatus = (typeof VARIANT_STATUSES)[number];
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type PublishMethod = (typeof PUBLISH_METHODS)[number];
export type PostMode = (typeof POST_MODES)[number];
export type Channel = z.infer<typeof zChannel>;
export type ChannelGroup = z.infer<typeof zChannelGroup>;

export interface Issue {
  level: "error" | "warning";
  field: string;
  message: string;
  /** Stable id of the check (e.g. "too-long"); quick fixes key on it. */
  code?: string;
}

export interface Delivery {
  status: DeliveryStatus;
  /** Explicit delivery time (epoch ms); otherwise derived from scheduledAt + stagger. */
  at?: number;
  url?: string;
  remoteId?: string;
  error?: string;
  attempts?: number;
  /** Why the delivery was skipped (optional, from the assisted flow). */
  reason?: string;
  /** Native hand-over (#66): the time the platform holds for this post (it moves only when an update is pushed). */
  remoteAt?: number;
  /** Native hand-over (#66): `contentDigest` of what was handed over; the note differs from the platform when it changes. */
  digest?: string;
  /**
   * The send key (M5 P17): written by the first claim of a send and kept across its retries and a re-send from
   * `failed`, so an adapter can derive the same platform keys (Bluesky record keys) on every attempt. Unlike `at`,
   * which every claim rewrites. Cleared once the delivery is published or re-planned (see `transition`).
   */
  sendAt?: number;
  /**
   * The send key as a TID (M5 P17b): random, written with `sendAt` at the first claim and kept and cleared under the
   * same rules. Bluesky derives the record key of every thread part from it (`tidParts`).
   */
  sendKey?: string;
  /** Opaque, bounded adapter checkpoint for safe continuation of a known partial remote send. */
  adapterState?: string;
}

export interface Campaign {
  path: string;
  title: string;
  anchorDate?: number;
  link?: string;
  status: "active" | "archived";
}

export interface WordPressFields {
  slug?: string;
  categories: string[];
  tags: string[];
  excerpt?: string;
  featuredImage?: string;
}

/** Per-image settings from `media_meta`, keyed by the link target used in `media:`. */
export interface MediaMeta {
  alt?: string;
  /** Focal point, 0..1 from the left and from the top; adapters crop around it. */
  focus?: [number, number];
}

export interface Variant {
  path: string;
  platform: Platform;
  /** Link target of the `campaign` wikilink, e.g. "Event X". */
  campaignLink?: string;
  title?: string;
  url?: string;
  channels: string[];
  mode: PostMode;
  /** Status as stored in frontmatter (kept in sync by roll-up). */
  status: VariantStatus;
  scheduledAt?: number;
  staggerMinutes?: number;
  reminders?: number[];
  media: string[];
  mediaMeta?: Record<string, MediaMeta>;
  deliveries: Record<string, Delivery>;
  /** Ids of delivery entries that exist but can't be read (e.g. a typo'd status). They are frozen: never published or overwritten. */
  invalidDeliveries?: string[];
  wordpress?: WordPressFields;
  /**
   * Set by the /social skill on a note written while Obsidian was closed; held from posting and reminders
   * until reviewed (#84). Any non-blank value holds (fail-closed); only "claude" is the canonical value
   * (`parseVariant` warns otherwise).
   */
  review?: string;
}

export interface Parsed<T> {
  value: T | null;
  issues: Issue[];
}
