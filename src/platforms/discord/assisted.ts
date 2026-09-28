import { imageItems } from "../share";
import type { AssistedBuilder } from "../types";

export const assisted: AssistedBuilder = (job) => {
  const handle = job.channel.handle?.trim() ?? "";
  return {
    url: handle.startsWith("https://discord.com/channels/") ? handle : "https://discord.com/channels/@me",
    clipboard: [{ label: "Message", text: job.text }, ...imageItems(job)],
    hint: `Open ${job.channel.name} and paste the message.`,
  };
};
