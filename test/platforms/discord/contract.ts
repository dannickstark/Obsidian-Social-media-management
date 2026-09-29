import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { DC, DC_TOKEN, DC_WEBHOOK } from "./fixtures";

export const discordCase: ContractCase = {
  platform: "discord",
  job: () => ({
    variant: { path: "Social/Posts/Dc.md", platform: "discord", channels: ["dc/maker-lab"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
    channel: channel("dc/maker-lab", { method: "api", secretId: "osmm-channel-dc-maker-lab" }),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
    text: "Doors open at 18:00",
    items: ["Doors open at 18:00"],
    body: "Doors open at 18:00",
    media: [],
    secret: DC_WEBHOOK,
  }),
  before: [json(200, DC.webhook)],
  success: { post: [json(200, DC.message)], expect: { remoteId: "1300000000000000004", url: "https://discord.com/channels/1000000000000000003/1100000000000000002/1300000000000000004" } },
  rateLimited: { post: [json(429, DC.rateLimited, { "Retry-After": "2" })], retryAfterMs: 1500 },
  authExpired: [json(401, DC.unauthorized)],
  forbidden: [json(403, DC.missingPermissions)],
  rejected: [json(400, DC.invalidForm)],
  // M5 P2: a webhook execute is not retry-safe; a Cloudflare 502/504 can come after the message was created, and a
  // webhook message can't be looked up without the id the lost answer carried.
  serverError: { post: [json(500, DC.serverError)], kind: "unknown" },
  sensitive: [DC_WEBHOOK, DC_TOKEN, encodeURIComponent(DC_WEBHOOK)],
};
