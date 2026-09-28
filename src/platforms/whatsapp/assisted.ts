import { enc, imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => ({
  url: `https://wa.me/?text=${enc(job.text)}`,
  clipboard: [{ label: "Message", text: job.text }, ...imageItems(job)],
  hint: `Pick ${job.channel.name} and send.`,
});
