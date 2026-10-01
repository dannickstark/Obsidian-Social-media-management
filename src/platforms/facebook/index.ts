import { MB, type PlatformDef } from "../types";

export const def: PlatformDef = {
  id: "facebook",
  dialect: "plain",
  preview: "feed",
  validate: (_input, channel) =>
    channel &&
    channel.method !== "assisted" &&
    (channel.kind !== "page" || !/^\d+$/.test(channel.handle ?? ""))
      ? [
          {
            level: "error",
            field: "channels",
            message:
              "Facebook API publishing needs a selected Page with a numeric Page id; use assisted publishing for profiles and groups.",
          },
        ]
      : [],
  capabilities: {
    api: true,
    nativeSchedule: true,
    threads: false,
    // approximate: fold
    limits: { maxChars: 63206, counter: "graphemes", foldAt: 480, link: "optional" },
    // approximate: image count and size
    media: { maxCount: 10, required: false, maxBytes: 10 * MB, video: false },
  },
};
