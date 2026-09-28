import { enc, imageItems, mastodonInstance, threadHint, threadItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const instance = mastodonInstance(job.channel.handle);
  return {
    url: instance ? `https://${instance}/share?text=${enc(job.items[0] ?? "")}` : null,
    clipboard: [...threadItems(job.items), ...imageItems(job)],
    hint: instance
      ? threadHint(job.items, "Check the pre-filled text and post.")
      : "Set this channel's handle to @you@your.instance so the right server opens; for now, paste the text into a new post.",
  };
};
