import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { TG, TG_TOKEN } from "./fixtures";

export const telegramCase: ContractCase = {
  platform: "telegram",
  job: () => ({
    variant: { path: "Social/Posts/Tg.md", platform: "telegram", channels: ["tg/event-x"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
    channel: channel("tg/event-x", { handle: "@eventx", method: "api", secretId: "osmm-channel-tg-event-x" }),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
    text: "Doors open at 18:00",
    items: ["Doors open at 18:00"],
    body: "Doors open at 18:00",
    media: [],
    secret: TG_TOKEN,
  }),
  before: [],
  success: { post: [json(200, TG.sendMessage)], expect: { remoteId: "42", url: "https://t.me/eventx/42" } },
  rateLimited: { post: [json(429, TG.tooMany)], retryAfterMs: 7000 },
  authExpired: [json(401, TG.unauthorized)],
  forbidden: [json(403, TG.kicked)],
  rejected: [json(400, TG.tooLong)],
  // M5 P2: a Telegram send is not retry-safe; the message may be out after a 502, and the Bot API can't be asked.
  serverError: { post: [json(502, TG.badGateway)], kind: "unknown" },
  sensitive: [TG_TOKEN, TG_TOKEN.split(":")[1]!],
};
