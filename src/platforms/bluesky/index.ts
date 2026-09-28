import { urlsIn } from "../text";
import type { PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "bluesky",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: true,
    limits: { maxChars: 300, counter: "graphemes", link: "optional" },
    // approximate: Bluesky's blob limit is about 1 MB per image
    media: { maxCount: 4, required: false, maxBytes: 1_000_000, video: false },
  },
  validate(input) {
    const hasLink = !!input.variant.url || urlsIn(input.body).length > 0;
    if (!hasLink || input.media.length === 0) return [];
    return [
      {
        level: "warning",
        field: "media",
        code: "bluesky-card",
        message: "Bluesky shows either images or a link card, not both. The link card will be left out.",
      },
    ];
  },
};
