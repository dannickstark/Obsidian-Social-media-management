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
  media: MediaInfo[];
  /** The channel's credential on this device, if any. */
  secret: string | null;
}

export interface RemoteState {
  published: boolean;
  url?: string;
  remoteId?: string;
}

/** Network operations of one platform (spec §4.1). Real adapters arrive in M5/M6; M2 only has test fakes. */
export interface PlatformAdapter {
  readonly platform: Platform;
  publish?(job: DeliveryJob): Promise<{ remoteId: string; url: string }>;
  schedule?(job: DeliveryJob): Promise<{ remoteId: string }>;
  update?(job: DeliveryJob): Promise<void>;
  cancel?(job: DeliveryJob): Promise<void>;
  lookup?(job: DeliveryJob): Promise<RemoteState | null>;
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
