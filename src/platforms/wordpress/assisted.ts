import { hostOf, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const site = hostOf(job.channel.handle);
  return {
    url: site ? `https://${site}/wp-admin/post-new.php` : null,
    clipboard: [
      { label: "Title", text: job.variant.title ?? "" },
      { label: "Article", text: job.text },
      ...imageItems(job),
    ],
    hint: site ? "Paste the title and the article, then publish or schedule it." : "Set this channel's handle to the site's domain; then paste the title and the article.",
  };
};
