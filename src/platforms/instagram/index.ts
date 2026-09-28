import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "instagram",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    // approximate: fold
    limits: { maxChars: 2200, counter: "graphemes", foldAt: 125, maxHashtags: 30, link: "none" },
    // approximate: carousel size and file size
    media: { maxCount: 10, required: true, maxBytes: 8 * MB, ratio: { min: 0.8, max: 1.91 }, video: false },
  },
};
