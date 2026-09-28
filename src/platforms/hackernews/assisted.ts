import { enc } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const title = job.variant.title ?? "";
  if (job.variant.url) {
    return {
      url: `https://news.ycombinator.com/submitlink?u=${enc(job.variant.url)}&t=${enc(title)}`,
      clipboard: [{ label: "Title", text: title }, ...(job.text ? [{ label: "First comment", text: job.text }] : [])],
      hint: job.text ? "Submit, then add the text as the first comment." : "Check the title and submit.",
    };
  }
  return {
    url: "https://news.ycombinator.com/submit",
    clipboard: [
      { label: "Title", text: title },
      { label: "Text", text: job.text },
    ],
    hint: "Paste the title and the text, then submit.",
  };
};
