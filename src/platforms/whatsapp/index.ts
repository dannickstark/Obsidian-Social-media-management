import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "whatsapp",
  dialect: "whatsapp",
  preview: "chat",
  capabilities: {
    api: false,
    nativeSchedule: false,
    threads: false,
    // approximate: message length and media
    limits: { maxChars: 65536, counter: "graphemes", link: "optional" },
    media: { maxCount: 30, required: false, maxBytes: 16 * MB, video: false },
  },
};
