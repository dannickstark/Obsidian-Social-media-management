import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { WP, WP_BASIC, WP_PASSWORD, WP_SITE } from "./fixtures";

const job = () => ({
  variant: {
    path: "Social/Event X/Event X – WordPress.md",
    platform: "wordpress" as const,
    channels: ["wp/eventx-berlin"],
    mode: "auto" as const,
    status: "scheduled" as const,
    title: "We're hosting Event X again",
    media: [],
    deliveries: {},
    wordpress: { slug: "hosting-event-x-again", categories: [], tags: [] },
  },
  channel: channel("wp/eventx-berlin", { kind: "site" as const, server: WP_SITE, login: "editor", method: "native" as const, secretId: "osmm-channel-wp-eventx-berlin" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW },
  text: "Six months ago we hosted the first Event X.",
  items: ["Six months ago we hosted the first Event X."],
  body: "Six months ago we hosted the first Event X.",
  media: [],
  secret: WP_PASSWORD,
});

export const wordpressCase: ContractCase = {
  platform: "wordpress",
  job,
  before: [],
  success: { post: [json(201, WP.post("publish"))], expect: { remoteId: "412", url: "https://eventx.berlin/hosting-event-x-again/" } },
  rateLimited: { post: [json(429, WP.tooMany, { "Retry-After": "30" })], retryAfterMs: 30_000 },
  authExpired: [json(401, WP.incorrectPassword)],
  forbidden: [json(403, WP.cannotCreate)],
  rejected: [json(400, WP.invalidParam)],
  serverError: { post: [json(500, WP.critical)], kind: "transient" },
  sensitive: [WP_PASSWORD, WP_BASIC],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW, sendAt: CONTRACT_NOW, remoteId: "412" } }),
    found: [json(200, WP.post("publish"))],
    expect: { published: true, remoteId: "412", url: "https://eventx.berlin/hosting-event-x-again/" },
    notFound: [json(404, WP.invalidId)],
    notFoundAnswer: "not_found",
  },
};
