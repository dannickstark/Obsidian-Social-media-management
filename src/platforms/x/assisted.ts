import { enc, imageItems, threadHint, threadItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: `https://x.com/intent/post?text=${enc(job.items[0] ?? "")}`,
  clipboard: [...threadItems(job.items), ...imageItems(job)],
  hint: threadHint(job.items, "Check the pre-filled text and post."),
});
