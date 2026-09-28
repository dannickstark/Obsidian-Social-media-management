import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: "https://www.indiehackers.com/new-post",
  clipboard: [
    { label: "Title", text: job.variant.title ?? "" },
    { label: "Text", text: job.text },
    ...imageItems(job),
  ],
  hint: "Paste the title and the text into the new post.",
});
