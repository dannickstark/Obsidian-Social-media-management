import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "discord",
  dialect: "markdown",
  preview: "chat",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 2000, counter: "graphemes", link: "optional" },
    // approximate: attachments per message and webhook upload size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
