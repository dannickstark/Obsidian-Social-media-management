import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: "https://www.instagram.com/",
  mobileUrl: "instagram://camera",
  clipboard: [{ label: "Caption", text: job.text }, ...imageItems(job)],
  hint: "Instagram has no web composer: create the post in the app and paste the caption.",
});
