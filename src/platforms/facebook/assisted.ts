import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

const PAGE_RE = /([A-Za-z0-9.]+)\/?$/;

export const assisted: AssistedBuilder = (job) => {
  const page = job.channel.handle ? PAGE_RE.exec(job.channel.handle.trim())?.[1] : undefined;
  const url = job.variant.url
    ? `https://www.facebook.com/sharer/sharer.php?u=${enc(job.variant.url)}`
    : page
      ? `https://www.facebook.com/${page}`
      : "https://www.facebook.com/";
  return { url, clipboard: [{ label: "Post text", text: job.text }, ...imageItems(job)], hint: "Facebook can't pre-fill text: paste it into the post box." };
};
