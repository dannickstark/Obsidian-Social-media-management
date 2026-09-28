import { enc, imageItems, subreddit } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const sub = subreddit(job.channel.handle);
  const base = sub ? `https://www.reddit.com/r/${sub}/submit` : "https://www.reddit.com/submit";
  const title = job.variant.title ?? "";
  const url = job.variant.url
    ? `${base}?title=${enc(title)}&url=${enc(job.variant.url)}`
    : `${base}?selftext=true&title=${enc(title)}&text=${enc(job.text)}`;
  return {
    url,
    clipboard: [{ label: "Title", text: title }, ...(job.text ? [{ label: "Text", text: job.text }] : []), ...imageItems(job)],
    hint: sub ? "Check the title and post." : "Pick the subreddit, check the title and post.",
  };
};
