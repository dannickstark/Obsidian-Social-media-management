import { channel, img } from "../fixtures";
import { json } from "../http";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import type { DeliveryJob } from "../../../src/platforms/types";

export const IG_ID = "31";
export const IG_TOKEN = "INSTAGRAM-USER-SECRET";
export const IG_PAGE_TOKEN = "INSTAGRAM-PAGE-SECRET";
const permalink = "https://www.instagram.com/p/CaBc123/";

export const instagramBefore = () => [
  json(200, {
    data: [
      {
        id: "41",
        name: "Studio Page",
        access_token: IG_PAGE_TOKEN,
        tasks: ["CREATE_CONTENT"],
        instagram_business_account: { id: IG_ID },
      },
    ],
  }),
  json(200, { data: [{ permission: "instagram_content_publish", status: "granted" }] }),
  json(200, { id: IG_ID, username: "studio", account_type: "BUSINESS" }),
  json(200, { id: "51" }),
  json(200, { id: "51", status_code: "FINISHED" }),
];

export const instagramJob = (): DeliveryJob => ({
  variant: {
    path: "Social/Posts/Instagram.md",
    platform: "instagram",
    channels: ["ig/studio"],
    mode: "auto",
    status: "scheduled",
    media: ["cover.png"],
    deliveries: {},
  },
  channel: channel("ig/studio", {
    kind: "profile",
    handle: IG_ID,
    method: "api",
    secretId: "ig-token",
  }),
  delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
  text: "A caption",
  items: ["A caption"],
  body: "A caption",
  media: [img("cover.png")],
  secret: IG_TOKEN,
});

export const instagramCase: ContractCase = {
  platform: "instagram",
  job: instagramJob,
  before: instagramBefore(),
  success: {
    post: [json(200, { id: "61" }), json(200, { id: "61", permalink, media_type: "IMAGE", username: "studio" })],
    expect: { remoteId: "61", url: permalink },
  },
  rateLimited: { post: [json(429, { error: { code: 4 } }, { "Retry-After": "20" })], retryAfterMs: 20_000 },
  authExpired: [json(400, { error: { code: 190 } })],
  forbidden: [json(403, { error: { code: 200 } })],
  rejected: [json(400, { error: { code: 100 } })],
  serverError: { post: [json(503, {})], kind: "unknown" },
  sensitive: [IG_TOKEN, IG_PAGE_TOKEN],
  lookup: {
    job: () => ({ ...instagramJob(), delivery: { status: "check_needed", remoteId: "61" } }),
    found: [...instagramBefore().slice(0, 3), json(200, { id: "61", permalink, media_type: "IMAGE", username: "studio" })],
    expect: { published: true, remoteId: "61", url: permalink },
    notFound: [...instagramBefore().slice(0, 3), json(404, { error: { code: 100 } })],
    notFoundAnswer: "unknown",
  },
};
