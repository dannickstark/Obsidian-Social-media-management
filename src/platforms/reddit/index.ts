import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "reddit",
  dialect: "markdown",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: self-text length, gallery size and image size
    limits: { maxChars: 40000, counter: "graphemes", titleRequired: true, titleMax: 300, link: "url-or-text" },
    media: { maxCount: 20, required: false, maxBytes: 20 * MB, video: false },
  },
};
