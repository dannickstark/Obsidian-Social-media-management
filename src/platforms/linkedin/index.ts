import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "linkedin",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 3000, counter: "graphemes", foldAt: 210, link: "optional" },
    // approximate: image count and size
    media: { maxCount: 9, required: false, maxBytes: 8 * MB, video: false },
  },
};
