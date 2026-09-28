import { MB, type PlatformDef } from "../types";

const SUBREDDIT_RE = /^r\/[A-Za-z0-9_]{2,21}$/;

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
  validate(_input, channel) {
    if (!channel || SUBREDDIT_RE.test(channel.handle ?? "")) return [];
    return [
      {
        level: "error",
        field: "channels",
        code: "missing-subreddit",
        message: `Set the subreddit (e.g. r/SideProject) as the handle of ${channel.name}.`,
      },
    ];
  },
};
