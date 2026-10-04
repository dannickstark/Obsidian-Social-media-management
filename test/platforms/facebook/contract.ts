import { channel } from "../fixtures";
import { json } from "../http";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import type { DeliveryJob } from "../../../src/platforms/types";

export const USER_TOKEN = "FACEBOOK-USER-SECRET";
export const PAGE_TOKEN = "FACEBOOK-PAGE-SECRET";
export const PAGE = {
  id: "11",
  name: "Event X",
  access_token: PAGE_TOKEN,
  tasks: ["CREATE_CONTENT"],
};
export const permissions = {
  data: ["pages_manage_posts", "pages_read_engagement"].map((permission) => ({
    permission,
    status: "granted",
  })),
};
export const before = () => [json(200, { data: [PAGE] }), json(200, permissions)];
export const live = {
  id: "11_42",
  is_published: true,
  permalink_url: "https://www.facebook.com/11/posts/42",
};
export const scheduled = {
  id: "11_42",
  is_published: false,
  scheduled_publish_time: (CONTRACT_NOW + 3_600_000) / 1000,
  attachments: { data: [] },
};
export const facebookJob = (): DeliveryJob => ({
  variant: {
    path: "Social/Posts/Facebook.md",
    platform: "facebook",
    channels: ["fb/event-x"],
    mode: "auto",
    status: "scheduled",
    media: [],
    deliveries: {},
  },
  channel: channel("fb/event-x", {
    kind: "page",
    handle: "11",
    method: "native",
    secretId: "fb-token",
  }),
  delivery: {
    status: "publishing",
    at: CONTRACT_NOW,
    attempts: 1,
    sendAt: CONTRACT_NOW,
    sendKey: "3m5n4w6fj2222",
  },
  text: "Doors open",
  items: ["Doors open"],
  body: "Doors open",
  media: [],
  secret: USER_TOKEN,
});
export const facebookCase: ContractCase = {
  platform: "facebook",
  job: facebookJob,
  before: before(),
  success: {
    post: [json(200, { id: "11_42" })],
    expect: { remoteId: "11_42", url: "https://www.facebook.com/11/posts/42" },
  },
  rateLimited: {
    post: [json(429, { error: { code: 4 } }, { "Retry-After": "30" })],
    retryAfterMs: 30_000,
  },
  authExpired: [json(400, { error: { code: 190 } })],
  forbidden: [json(403, { error: { code: 200 } })],
  rejected: [json(400, { error: { code: 100 } })],
  serverError: { post: [json(503, {})], kind: "unknown" },
  sensitive: [USER_TOKEN, PAGE_TOKEN],
  lookup: {
    job: () => ({ ...facebookJob(), delivery: { status: "check_needed", remoteId: "11_42" } }),
    found: [...before(), json(200, live)],
    expect: { published: true, remoteId: "11_42", url: live.permalink_url },
    // Graph's "missing object" can also mean lost permissions. It is never evidence of deletion.
    notFound: [...before(), json(400, { error: { code: 100, error_subcode: 33 } })],
    notFoundAnswer: "unknown",
  },
};
