import { postText, urlsIn } from "../text";
import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "linkedin",
  dialect: "plain",
  preview: "feed",
  capabilities: {
    api: true,
    nativeSchedule: false,
    threads: false,
    limits: { maxChars: 3000, counter: "graphemes", foldAt: 210, link: "optional" },
    // Images upload one at a time and are combined with LinkedIn's organic MultiImage Posts API.
    media: { maxCount: 9, required: false, maxBytes: 8 * MB, video: false },
  },
  validate(input) {
    if (urlsIn(postText(input.body, def)).length === 0) return [];
    return [
      {
        level: "warning",
        field: "body",
        code: "link-in-body",
        message: "Posts with a link in the text often reach fewer people on LinkedIn. Consider moving the link to the first comment.",
      },
    ];
  },
};
