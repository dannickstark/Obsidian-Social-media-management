import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "indiehackers",
  dialect: "markdown",
  preview: "link",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: text and title length, image size
    limits: { maxChars: 40000, counter: "graphemes", titleRequired: true, titleMax: 150, link: "optional" },
    media: { maxCount: 10, required: false, maxBytes: 5 * MB, video: false },
  },
};
