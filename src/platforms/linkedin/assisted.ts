import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

const COMPANY_RE = /(?:company\/)?([A-Za-z0-9-]+)\/?$/;

export const assisted: AssistedBuilder = (job) => {
  const clipboard = [{ label: "Post text", text: job.text }, ...imageItems(job)];
  if (job.channel.kind === "page") {
    const company = job.channel.handle ? COMPANY_RE.exec(job.channel.handle.trim())?.[1] : undefined;
    return company
      ? { url: `https://www.linkedin.com/company/${company}/admin/page-posts/published/?share=true`, clipboard, hint: `Paste the text into ${job.channel.name}'s post box and post.` }
      : { url: "https://www.linkedin.com/feed/", clipboard, hint: `Switch to ${job.channel.name} (Me, then Pages), start a post and paste the text.` };
  }
  return { url: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(job.text)}`, clipboard, hint: "Check the pre-filled text and post." };
};
