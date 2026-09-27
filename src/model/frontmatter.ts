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
import type { Campaign, Delivery, Issue, Parsed, Variant } from "./types";

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

function parseDeliveries(raw: unknown, channels: string[], issues: Issue[]): Record<string, Delivery> {
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
      continue;
    }
    const status = take(zDeliveryStatus, value.status, `${field}.status`, issues, "warning");
    if (!status) continue;
    const d: Delivery = { status };
    const at = takeDate(value.at, `${field}.at`, issues);
    if (at !== undefined) d.at = at;
    if (typeof value.url === "string" && value.url) d.url = value.url;
    if (!isBlank(value.remote_id)) d.remoteId = String(value.remote_id);
    if (typeof value.error === "string" && value.error) d.error = value.error;
    const attempts = take(zCount, value.attempts, `${field}.attempts`, issues, "warning");
    if (attempts !== undefined) d.attempts = attempts;
    if (!channels.includes(id)) {
      issues.push({ level: "warning", field, message: `Delivery for ${id}, which is not in channels` });
    }
    deliveries[id] = d;
  }
  return deliveries;
}

export function parseVariant(fm: Record<string, unknown>, path: string): Parsed<Variant> {
  const issues: Issue[] = [];
  if (isBlank(fm.platform)) {
    return { value: null, issues: [{ level: "error", field: "platform", message: "platform is required" }] };
  }
  const platform = take(zPlatform, fm.platform, "platform", issues);
  if (!platform) return { value: null, issues };

  const channels: string[] = [];
  for (const raw of asList(fm.channels)) {
    const id = take(zChannelId, typeof raw === "string" ? raw.trim() : raw, "channels", issues, "warning");
    if (!id) continue;
    if (channelPlatform(id) !== platform) {
      issues.push({ level: "warning", field: "channels", message: `${id} is not a ${PLATFORM_META[platform].label} channel` });
      continue;
    }
    if (!channels.includes(id)) channels.push(id);
  }

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
      : take(zMinutesList, asList(fm.reminders), "reminders", issues, "warning"),
    media: asList(fm.media)
      .map(linkTarget)
      .filter((m): m is string => m !== undefined),
    deliveries: parseDeliveries(fm.deliveries, channels, issues),
  };

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
    "channels" | "mode" | "status" | "scheduledAt" | "staggerMinutes" | "reminders" | "media" | "title" | "url" | "deliveries"
  >
>;

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
  if ("title" in patch) out.title = patch.title;
  if ("url" in patch) out.url = patch.url;
  if ("deliveries" in patch) out.deliveries = patch.deliveries ? serializeDeliveries(patch.deliveries) : undefined;
  return out;
}
