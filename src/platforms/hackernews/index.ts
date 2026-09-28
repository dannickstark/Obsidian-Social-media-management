import { type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "hackernews",
  dialect: "plain",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: text length
    limits: { maxChars: 4000, counter: "graphemes", titleRequired: true, titleMax: 80, link: "url-or-text" },
    media: { maxCount: 0, required: false, maxBytes: 0, video: false },
  },
};
