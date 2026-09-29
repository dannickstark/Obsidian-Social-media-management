import { z } from "zod";
import { formatDateTime, parseDateTime } from "./dates";
import { PLATFORM_META, channelPlatform } from "./platforms";
import {
  POST_MODES,
  zChannelId,
  zCount,
  zDeliveryStatus,
  zMinutes,
  zMinutesList,
  zPlatform,
  zUrl,
  zVariantStatus,
} from "./schemas";
import type { Campaign, Delivery, Issue, MediaMeta, Parsed, Variant, WordPressFields } from "./types";
import { TID_RE } from "../platforms/bluesky/tid";

export type SocialKind = "campaign" | "post";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function socialKind(fm: unknown): SocialKind | null {
  if (!isRecord(fm)) return null;
  if (fm.type === "social-campaign") return "campaign";
  if (fm.type === "social-post") return "post";
  return null;
}

const WIKILINK_RE = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

/** "[[Event X|alias]]" → "Event X"; plain strings are returned trimmed. */
export function linkTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  const m = WIKILINK_RE.exec(s);
  const target = (m ? m[1] : s)?.trim();
  return target ? target : undefined;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function asList(value: unknown): unknown[] {
  if (isBlank(value)) return [];
  return Array.isArray(value) ? value : [value];
}

/** Like asList, but also splits a comma-separated string ("li/me, li/acme"); commas inside [[wikilinks]] are kept. */
function splitList(value: unknown): unknown[] {
  if (typeof value !== "string") return asList(value);
  return value
    .split(/,(?![^[]*\]\])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function take<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
  issues: Issue[],
  level: Issue["level"] = "error",
): T | undefined {
  if (isBlank(value)) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  issues.push({ level, field, message: r.error.issues[0]?.message ?? "Invalid value" });
  return undefined;
}

function takeDate(value: unknown, field: string, issues: Issue[]): number | undefined {
  if (isBlank(value)) return undefined;
  const t = parseDateTime(value);
  if (t === null) {
    issues.push({ level: "error", field, message: `"${String(value)}" is not a valid date/time` });
    return undefined;
  }
  return t;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] {
  return asList(value)
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function parseCampaign(fm: Record<string, unknown>, path: string): Parsed<Campaign> {
  const issues: Issue[] = [];
  const campaign: Campaign = {
    path,
    title: str(fm.title) ?? basename(path),
    anchorDate: takeDate(fm.anchor_date, "anchor_date", issues),
    link: take(zUrl, fm.link, "link", issues, "warning"),
    status: take(z.enum(["active", "archived"]), fm.status, "status", issues, "warning") ?? "active",
  };
  return { value: campaign, issues };
}

function parseDeliveries(raw: unknown, channels: string[], issues: Issue[], invalid: string[]): Record<string, Delivery> {
  const deliveries: Record<string, Delivery> = {};
  if (isBlank(raw)) return deliveries;
  if (!isRecord(raw)) {
    issues.push({ level: "warning", field: "deliveries", message: "deliveries must be a map of channel id → delivery" });
    return deliveries;
  }
  for (const [id, value] of Object.entries(raw)) {
    const field = `deliveries.${id}`;
    if (!isRecord(value)) {
      issues.push({ level: "warning", field, message: "Delivery must be an object" });
      invalid.push(id);
      continue;
    }
    const status = take(zDeliveryStatus, value.status, `${field}.status`, issues, "warning");
    if (!status) {
      invalid.push(id);
      continue;
    }
    const d: Delivery = { status };
    const at = takeDate(value.at, `${field}.at`, issues);
    if (at !== undefined) d.at = at;
    if (typeof value.url === "string" && value.url) d.url = value.url;
    if (!isBlank(value.remote_id)) d.remoteId = String(value.remote_id);
    if (typeof value.error === "string" && value.error) d.error = value.error;
    const attempts = take(zCount, value.attempts, `${field}.attempts`, issues, "warning");
    if (attempts !== undefined) d.attempts = attempts;
    if (typeof value.reason === "string" && value.reason.trim()) d.reason = value.reason.trim();
    const remoteAt = takeDate(value.remote_at, `${field}.remote_at`, issues);
    if (remoteAt !== undefined) d.remoteAt = remoteAt;
    const sendAt = takeDate(value.send_at, `${field}.send_at`, issues);
    if (sendAt !== undefined) d.sendAt = sendAt;
    if (!isBlank(value.send_key)) {
      const sendKey = String(value.send_key).trim();
      if (TID_RE.test(sendKey)) d.sendKey = sendKey;
      else issues.push({ level: "warning", field: `${field}.send_key`, message: `"${sendKey}" is not a valid send key` });
    }
    // YAML reads an all-digit digest as a number; it is still the same digest.
    const digest = typeof value.digest === "string" || typeof value.digest === "number" ? String(value.digest).trim() : "";
    if (digest) d.digest = digest;
    if (!channels.includes(id)) {
      issues.push({ level: "warning", field, message: `Delivery for ${id}, which is not in channels` });
    }
    deliveries[id] = d;
  }
  return deliveries;
}

function parseFocus(value: unknown): [number, number] | undefined {
  const parts: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (parts.length !== 2) return undefined;
  const nums = parts.map((p) => (typeof p === "number" ? p : typeof p === "string" && p.trim() ? Number(p) : Number.NaN));
  return nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ? [nums[0]!, nums[1]!] : undefined;
}

function parseMediaMeta(raw: unknown, issues: Issue[]): Record<string, MediaMeta> | undefined {
  if (isBlank(raw)) return undefined;
  if (!isRecord(raw)) {
    issues.push({ level: "warning", field: "media_meta", message: "media_meta must be a map of image → { alt, focus }" });
    return undefined;
  }
  const out: Record<string, MediaMeta> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = linkTarget(key) ?? key;
    const field = `media_meta.${target}`;
    if (!isRecord(value)) {
      issues.push({ level: "warning", field, message: "Each entry must be a map with alt and focus" });
      continue;
    }
    const meta: MediaMeta = {};
    if (typeof value.alt === "string") {
      if (value.alt.trim()) meta.alt = value.alt.trim();
    } else if (!isBlank(value.alt)) {
      issues.push({ level: "warning", field: `${field}.alt`, message: "alt must be text, e.g. alt: Makers at laptops" });
    }
    if (!isBlank(value.focus)) {
      const focus = parseFocus(value.focus);
      if (focus) meta.focus = focus;
      else issues.push({ level: "warning", field: `${field}.focus`, message: "focus must be two numbers between 0 and 1, e.g. 0.5, 0.3" });
    }
    out[target] = meta;
  }
  return out;
}

export function serializeMediaMeta(meta: Record<string, MediaMeta> | undefined): Record<string, unknown> | undefined {
  const entries = Object.entries(meta ?? {})
    .map(([target, m]) => {
      const out: Record<string, unknown> = {};
      if (m.alt) out.alt = m.alt;
      if (m.focus) out.focus = m.focus.map((n) => Math.round(n * 100) / 100);
      return [target, out] as const;
    })
    .filter(([, out]) => Object.keys(out).length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function parseVariant(fm: Record<string, unknown>, path: string): Parsed<Variant> {
  const issues: Issue[] = [];
  if (isBlank(fm.platform)) {
    return { value: null, issues: [{ level: "error", field: "platform", message: "platform is required" }] };
  }
  const platform = take(zPlatform, fm.platform, "platform", issues);
  if (!platform) return { value: null, issues };

  const channels: string[] = [];
  for (const raw of splitList(fm.channels)) {
    const id = take(zChannelId, typeof raw === "string" ? raw.trim() : raw, "channels", issues, "warning");
    if (!id) continue;
    if (channelPlatform(id) !== platform) {
      issues.push({ level: "warning", field: "channels", message: `${id} is not a ${PLATFORM_META[platform].label} channel` });
      continue;
    }
    if (!channels.includes(id)) channels.push(id);
  }

  const invalidDeliveries: string[] = [];
  const variant: Variant = {
    path,
    platform,
    campaignLink: linkTarget(fm.campaign),
    title: str(fm.title),
    url: take(zUrl, fm.url, "url", issues, "warning"),
    channels,
    mode: take(z.enum(POST_MODES), fm.mode, "mode", issues, "warning") ?? "auto",
    status: take(zVariantStatus, fm.status, "status", issues, "warning") ?? "draft",
    scheduledAt: takeDate(fm.scheduled_at, "scheduled_at", issues),
    staggerMinutes: take(zMinutes, fm.stagger_minutes, "stagger_minutes", issues, "warning"),
    reminders: isBlank(fm.reminders)
      ? undefined
      : take(zMinutesList, splitList(fm.reminders), "reminders", issues, "warning"),
    media: splitList(fm.media)
      .map(linkTarget)
      .filter((m): m is string => m !== undefined),
    deliveries: parseDeliveries(fm.deliveries, channels, issues, invalidDeliveries),
  };

  const mediaMeta = parseMediaMeta(fm.media_meta, issues);
  if (mediaMeta) variant.mediaMeta = mediaMeta;
  if (invalidDeliveries.length) variant.invalidDeliveries = invalidDeliveries;

  if (!isBlank(fm.review)) {
    // Fix round 1 (I1): fail-closed — any non-blank value holds the note, whatever it is; only exactly
    // "claude" is canonical, so anything else also gets a warning.
    variant.review = typeof fm.review === "string" ? fm.review : JSON.stringify(fm.review);
    if (variant.review !== "claude") {
      issues.push({ level: "warning", field: "review", message: 'review can only be "claude" (set by the /social skill on notes written while Obsidian was closed).' });
    }
  }

  if (platform === "wordpress") {
    variant.wordpress = {
      slug: str(fm.slug),
      categories: strList(fm.categories),
      tags: strList(fm.tags),
      excerpt: str(fm.excerpt),
      featuredImage: linkTarget(fm.featured_image),
    };
  }

  return { value: variant, issues };
}

export function serializeDelivery(d: Delivery): Record<string, unknown> {
  const out: Record<string, unknown> = { status: d.status };
  if (d.at !== undefined) out.at = formatDateTime(d.at);
  if (d.url) out.url = d.url;
  if (d.remoteId) out.remote_id = d.remoteId;
  if (d.error) out.error = d.error;
  if (d.attempts !== undefined) out.attempts = d.attempts;
  if (d.reason) out.reason = d.reason;
  if (d.remoteAt !== undefined) out.remote_at = formatDateTime(d.remoteAt);
  if (d.digest) out.digest = d.digest;
  if (d.sendAt !== undefined) out.send_at = formatDateTime(d.sendAt);
  if (d.sendKey) out.send_key = d.sendKey;
  return out;
}

export function serializeDeliveries(ds: Record<string, Delivery>): Record<string, unknown> | undefined {
  const entries = Object.entries(ds);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([id, d]) => [id, serializeDelivery(d)]));
}

export type VariantPatch = Partial<
  Pick<
    Variant,
    | "channels"
    | "mode"
    | "status"
    | "scheduledAt"
    | "staggerMinutes"
    | "reminders"
    | "media"
    | "mediaMeta"
    | "title"
    | "url"
    | "deliveries"
    | "review"
  >
> & {
  /** Only the WordPress fields to write; keys left out stay as they are in the note. */
  wordpress?: Partial<WordPressFields>;
};

/** Map a camelCase patch to frontmatter keys. A key mapped to `undefined` means "delete this key". */
export function variantFields(patch: VariantPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("channels" in patch) out.channels = patch.channels;
  if ("mode" in patch) out.mode = patch.mode;
  if ("status" in patch) out.status = patch.status;
  if ("scheduledAt" in patch) out.scheduled_at = patch.scheduledAt === undefined ? undefined : formatDateTime(patch.scheduledAt);
  if ("staggerMinutes" in patch) out.stagger_minutes = patch.staggerMinutes;
  if ("reminders" in patch) out.reminders = patch.reminders;
  if ("media" in patch) out.media = patch.media?.map((m) => `[[${m}]]`);
  if ("mediaMeta" in patch) out.media_meta = serializeMediaMeta(patch.mediaMeta);
  if ("title" in patch) out.title = patch.title;
  if ("url" in patch) out.url = patch.url;
  if ("deliveries" in patch) out.deliveries = patch.deliveries ? serializeDeliveries(patch.deliveries) : undefined;
  if ("review" in patch) out.review = patch.review;
  if ("wordpress" in patch) {
    // WordPress fields are top-level keys, written one by one; an empty value removes its key.
    const wp = patch.wordpress ?? {};
    if ("slug" in wp) out.slug = wp.slug || undefined;
    if ("excerpt" in wp) out.excerpt = wp.excerpt || undefined;
    if ("categories" in wp) out.categories = wp.categories?.length ? wp.categories : undefined;
    if ("tags" in wp) out.tags = wp.tags?.length ? wp.tags : undefined;
    if ("featuredImage" in wp) out.featured_image = wp.featuredImage ? `[[${wp.featuredImage}]]` : undefined;
  }
  return out;
}
