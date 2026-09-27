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
}

export interface Delivery {
  status: DeliveryStatus;
  /** Explicit delivery time (epoch ms); otherwise derived from scheduledAt + stagger. */
  at?: number;
  url?: string;
  remoteId?: string;
  error?: string;
  attempts?: number;
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
  deliveries: Record<string, Delivery>;
  wordpress?: WordPressFields;
}

export interface Parsed<T> {
  value: T | null;
  issues: Issue[];
}
