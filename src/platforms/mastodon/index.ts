import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "mastodon",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: true,
    // 500 is the default instance limit; a channel can override it (Channel.maxChars, Task 3).
    limits: { maxChars: 500, counter: "mastodon", link: "optional" },
    // approximate: file size (instance dependent) and feed crop
    media: { maxCount: 4, required: false, maxBytes: 8 * MB, cropRatio: 16 / 9, video: false },
  },
};
