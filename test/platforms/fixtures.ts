import { channelPlatform, type Platform } from "../../src/model/platforms";
import type { Channel, Issue, Variant } from "../../src/model/types";
import type { ComposeInput, MediaInfo } from "../../src/platforms/types";

export function input(platform: Platform, body: string, extra: Partial<Variant> = {}, media: MediaInfo[] = []): ComposeInput {
  return {
    variant: {
      path: "Social/Posts/P.md",
      platform,
      channels: [],
      mode: "auto",
      status: "draft",
      media: media.map((m) => m.target),
      deliveries: {},
      ...extra,
    },
    body,
    media,
  };
}

export function img(target = "a.png", width = 1080, height = 1080, extra: Partial<MediaInfo> = {}): MediaInfo {
  return { target, path: `Social/${target}`, kind: "image", mime: "image/png", bytes: 200_000, width, height, alt: "An image", ...extra };
}

export function channel(id: string, extra: Partial<Channel> = {}): Channel {
  return { id, platform: channelPlatform(id)!, name: id, kind: "profile", avatarColor: "#888888", method: "assisted", ...extra };
}

export const messages = (issues: readonly Issue[]): string[] => issues.map((i) => `${i.level}:${i.field}:${i.message}`);
