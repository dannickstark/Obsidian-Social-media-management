import { z } from "zod";
import { CHANNEL_ID_RE, PLATFORMS, PLATFORM_META } from "./platforms";
import type { Issue } from "./types";

export const DELIVERY_STATUSES = [
  "draft",
  "ready",
  "scheduled",
  "handed_over",
  "publishing",
  "published",
  "failed",
  "awaiting_you",
  "skipped",
  "overdue",
  "check_needed",
] as const;

export const VARIANT_STATUSES = [
  "idea",
  "draft",
  "ready",
  "scheduled",
  "partial",
  "published",
  "overdue",
  "attention",
  "skipped",
] as const;

export const CHANNEL_KINDS = ["profile", "page", "group", "server_channel", "site", "account"] as const;
export const PUBLISH_METHODS = ["api", "native", "assisted"] as const;
export const POST_MODES = ["auto", "assisted"] as const;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const zPlatform = z.enum(PLATFORMS);
export const zChannelId = z.string().regex(CHANNEL_ID_RE, 'Channel id must look like "li/acme-studio"');
export const zDeliveryStatus = z.enum(DELIVERY_STATUSES);
export const zVariantStatus = z.enum(VARIANT_STATUSES);
export const zMinutes = z.coerce.number().int().min(0).max(60 * 24 * 14);
export const zMinutesList = z.array(zMinutes).max(10);
export const zCount = z.coerce.number().int().min(0);
export const zTimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
export const zUrl = z.url();
export const zHexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #6ea3e6");
export const zSecretId = z.string().regex(SLUG_RE, "Use lowercase letters, digits and dashes");

export const zChannel = z
  .object({
    id: zChannelId,
    platform: zPlatform,
    name: z.string().trim().min(1, "Name is required"),
    kind: z.enum(CHANNEL_KINDS),
    handle: z.string().optional(),
    avatarColor: zHexColor,
    method: z.enum(PUBLISH_METHODS),
    secretId: zSecretId.optional(),
    defaultTime: zTimeOfDay.optional(),
    defaultReminders: zMinutesList.optional(),
  })
  .superRefine((c, ctx) => {
    const meta = PLATFORM_META[c.platform];
    if (!c.id.startsWith(`${meta.prefix}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: `Channel id must start with "${meta.prefix}/" for ${meta.label}`,
      });
    }
  });

export const zChannelGroup = z.object({
  id: z.string().regex(SLUG_RE, "Use lowercase letters, digits and dashes"),
  name: z.string().trim().min(1, "Name is required"),
  channelIds: z.array(zChannelId),
});

export function zodIssues(error: z.ZodError, prefix = ""): Issue[] {
  return error.issues.map((i) => ({
    level: "error" as const,
    field: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    message: i.message,
  }));
}
