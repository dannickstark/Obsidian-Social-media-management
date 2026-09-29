import type { Issue } from "../../model/types";
import { MB, type PlatformDef } from "../types";

/** Discord's limit for an attachment's description (alt text), counted by code points; the adapter cuts the rest. */
export const ALT_MAX = 1024;

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
  validate(input): Issue[] {
    return input.media
      .filter((m) => m.kind === "image" && m.alt !== undefined && Array.from(m.alt).length > ALT_MAX)
      .map((m) => ({ level: "warning", field: `media.${m.target}`, code: "alt-too-long", message: `${m.target}: Discord shows at most 1,024 characters of alt text; the rest is cut.` }));
  },
};
