import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "telegram",
  dialect: "telegram",
  preview: "chat",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 4096, maxCharsWithMedia: 1024, counter: "graphemes", link: "optional" },
    // approximate: album size and photo size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
