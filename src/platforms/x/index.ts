import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "x",
  dialect: "plain",
  preview: "thread",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: true,
    limits: { maxChars: 280, counter: "x-weighted", link: "optional" },
    // approximate: file size and feed crop
    media: { maxCount: 4, required: false, maxBytes: 5 * MB, cropRatio: 16 / 9, video: false },
  },
};
