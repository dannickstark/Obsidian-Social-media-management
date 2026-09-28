import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "wordpress",
  dialect: "html",
  preview: "article",
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: article length and upload size (site dependent)
    limits: { maxChars: 1_000_000, counter: "graphemes", titleRequired: true, link: "none" },
    media: { maxCount: 50, required: false, maxBytes: 20 * MB, video: false },
  },
};
