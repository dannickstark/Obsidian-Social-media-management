import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { MA, MA_KEY, MA_RATE, MA_TOKEN } from "./fixtures";

const job = () => ({
  variant: { path: "Social/Posts/Ma.md", platform: "mastodon" as const, channels: ["ma/you"], mode: "auto" as const, status: "scheduled" as const, media: [], deliveries: {} },
  channel: channel("ma/you", { handle: "@you@mastodon.social", method: "native" as const, secretId: "osmm-channel-ma-you" }),
  // M5 P17/P17b: every part's Idempotency-Key comes from the send key the first claim writes.
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW, sendKey: MA_KEY },
  text: "Doors open at 18:00",
  items: ["Doors open at 18:00"],
  body: "Doors open at 18:00",
  media: [],
  secret: MA_TOKEN,
});

export const mastodonCase: ContractCase = {
  platform: "mastodon",
  job,
  before: [],
  success: { post: [json(200, MA.status())], expect: { remoteId: "113258473000000001", url: "https://mastodon.social/@you/113258473000000001" } },
  rateLimited: { post: [json(429, MA.tooMany, MA_RATE)], retryAfterMs: 30_000 },
  authExpired: [json(401, MA.invalidToken)],
  forbidden: [json(403, MA.scope)],
  rejected: [json(422, MA.tooLong)],
  // M5 P2: an immediate post carries an Idempotency-Key from the send key, so a retry returns the first post.
  serverError: { post: [json(503, MA.unavailable)], kind: "transient" },
  sensitive: [MA_TOKEN, encodeURIComponent(MA_TOKEN)],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: MA_KEY } }),
    found: [json(200, MA.account), json(200, [MA.status()])],
    expect: { published: true, remoteId: "113258473000000001", url: "https://mastodon.social/@you/113258473000000001" },
    notFound: [json(200, MA.account), json(200, [])],
    // A text-fingerprint search: a miss can't tell (M5 P5).
    notFoundAnswer: "unknown",
  },
};
