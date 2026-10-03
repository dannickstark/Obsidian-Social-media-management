import type { CharCounter } from "../model/body";
import type { Platform } from "../model/platforms";
import type { Channel, Delivery, Issue, Variant } from "../model/types";

export const MB = 1024 * 1024;

/** How the note's Markdown becomes the text the platform receives (see text.ts). */
export type TextDialect = "plain" | "markdown" | "telegram" | "whatsapp" | "html";

/** Which preview renderer draws the platform. */
export type PreviewLayout = "feed" | "thread" | "chat" | "link" | "article";

export interface Limits {
  /** Maximum characters per post; on thread platforms, per thread item. */
  maxChars: number;
  counter: CharCounter;
  /** A stricter limit for the text when media is attached (a Telegram caption). */
  maxCharsWithMedia?: number;
  /** Characters visible before the platform folds the text ("…see more"). */
  foldAt?: number;
  titleRequired?: boolean;
  titleMax?: number;
  /** `required`: needs `url`; `url-or-text`: needs `url` or a body; `none`: `url` is not used. */
  link: "optional" | "required" | "url-or-text" | "none";
  maxHashtags?: number;
}

export interface MediaRules {
  /** 0 means the platform shows no attached media. */
  maxCount: number;
  required: boolean;
  maxBytes: number;
  /** Accepted aspect ratios, width / height. */
  ratio?: { min: number; max: number };
  /** Ratio the feed crops a single image to, for the crop preview. */
  cropRatio?: number;
  /** Video upload is not supported anywhere in v1. */
  video: false;
}

export interface Capabilities {
  api: boolean;
  nativeSchedule: boolean;
  threads: boolean;
  media: MediaRules;
  limits: Limits;
}

export interface MediaInfo {
  /** Link target as written in `media:` (e.g. "event-x-cover.png"). */
  target: string;
  /** Vault path when the link resolves. */
  path?: string;
  kind: "image" | "video" | "unsupported" | "missing";
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  alt?: string;
  /** Focal point, 0..1 from the left and from the top. */
  focus?: [number, number];
  /** Live content hashes of generated assets, so a binary edit invalidates approval. */
  fingerprint?: string;
  sourceFingerprint?: string;
}

/** What validators and previews look at: the note's fields, its Markdown body and its resolved media. */
export interface ComposeInput {
  variant: Variant;
  body: string;
  media: MediaInfo[];
}

/** The static half of spec §4.1: capabilities, limits and checks. Network operations live in PlatformAdapter. */
export interface PlatformDef {
  id: Platform;
  capabilities: Capabilities;
  dialect: TextDialect;
  preview: PreviewLayout;
  /** Platform-specific checks, run after the shared rule checks. */
  validate?(input: ComposeInput, channel?: Channel): Issue[];
}

/** Everything an adapter needs to run one delivery. */
export interface DeliveryJob {
  variant: Variant;
  channel: Channel;
  delivery: Delivery;
  /** The whole post as the platform receives it. */
  text: string;
  /** Thread items (a single item on platforms without threads). */
  items: string[];
  /**
   * The note's raw Markdown body (M5 P3). `text` has every image embed stripped, so an adapter that renders
   * Markdown itself (WordPress) reads this instead. Covered by `sendDigest` / `contentDigest` (the body).
   */
  body: string;
  media: MediaInfo[];
  /** WordPress: the resolved `featured_image` (part of `sendDigest`). */
  featured?: MediaInfo;
  /** The channel's credential on this device, if any. */
  secret: string | null;
  /**
   * M5 P17c: the claim found this delivery's send key already on disk (a retry, a re-send, a re-planned failure), so
   * an earlier attempt may have posted part of it. Set by the orchestrator.
   */
  resume?: boolean;
}

/** What the platform says about a post. `published: false` with nothing else means "not found". */
export interface RemoteState {
  published: boolean;
  url?: string;
  remoteId?: string;
  /** Still waiting in the platform's own schedule (native hand-over), at this time. */
  scheduledAt?: number;
  /** The platform is sure it no longer has the post (deleted or taken off its schedule there). */
  gone?: boolean;
  /** Not (fully) published, and why: part of a thread is out (M5 P17c). Kept as the delivery's error. */
  note?: string;
}

export interface PublishResult {
  remoteId: string;
  url: string;
  /** The post is out, but not all of it (a thread cut short); shown to the user and kept on the delivery. */
  note?: string;
}

export interface ScheduleResult {
  remoteId: string;
  url?: string;
}

/** What differs from the platform's copy of a handed-over post (#66). */
export interface SyncChange {
  content: boolean;
  time: boolean;
}

export type VerifyResult = { ok: true; account: string } | { ok: false; error: string };

/**
 * Network operations of one platform (spec §4.1). Every request goes through `ApiClient` (src/platforms/http.ts),
 * and every adapter passes the contract suite (test/platforms/contract). An adapter reads post content only from
 * the job and from DIGESTED_VARIANT_FIELDS (src/publish/sync.ts).
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** Runtime product or permission gate; false routes automatic publishing to the assisted flow. */
  apiAvailable?(channel: Channel): boolean;
  /** How far ahead a native hand-over must be (Mastodon: 5 minutes). */
  readonly minLeadMs?: number;
  publish?(job: DeliveryJob): Promise<PublishResult>;
  /** Hands the post over to the platform's scheduler for `job.delivery.at`. */
  schedule?(job: DeliveryJob): Promise<ScheduleResult>;
  /** Why this job can't be handed over (a Mastodon thread), or null. */
  scheduleRefusal?(job: DeliveryJob): string | null;
  /** Pushes the note's current version (#66). `change` is absent for a live post edited through push_update. */
  update?(job: DeliveryJob, change?: SyncChange): Promise<{ remoteId?: string } | void>;
  /** Takes a handed-over post off the platform's schedule. */
  cancel?(job: DeliveryJob): Promise<void>;
  lookup?(job: DeliveryJob): Promise<RemoteState | null>;
  /** Channel settings "Test connection". Never throws. */
  verify?(channel: Channel, secret: string | null): Promise<VerifyResult>;
}

/** One thing for the user to paste: text, or an image file from the vault. */
export type ClipItem = { label: string; text: string } | { label: string; imagePath: string };

/** What the assisted flow opens and copies for one delivery (the spec's assistedUrl, plus the clipboard steps). */
export interface AssistedTarget {
  /** Pre-filled compose or submit page; null when there is none to open. */
  url: string | null;
  /** App deep link used on phones instead of `url`. */
  mobileUrl?: string;
  /** What to paste, in order; the first item is copied when the page opens. */
  clipboard: ClipItem[];
  /** One short instruction for the page. */
  hint: string;
}

export interface AssistedJob {
  variant: Variant;
  channel: Channel;
  /** The whole post as the platform receives it. */
  text: string;
  items: string[];
  media: MediaInfo[];
}

export type AssistedBuilder = (job: AssistedJob) => AssistedTarget;
