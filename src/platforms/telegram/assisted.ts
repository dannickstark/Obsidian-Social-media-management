import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: job.variant.url ? `https://t.me/share/url?url=${enc(job.variant.url)}&text=${enc(job.text)}` : `https://t.me/share/url?url=${enc(job.text)}`,
  clipboard: [{ label: "Post text", text: job.text }, ...imageItems(job)],
  hint: `Pick ${job.channel.name} and send.`,
});
