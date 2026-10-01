import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { json } from "../http";
import type { DeliveryJob } from "../../../src/platforms/types";

export const LINKEDIN_TOKEN = "linkedin-member-access-secret";
export const LINKEDIN_POST_ID = "urn:li:share:44";

export const linkedinJob = (): DeliveryJob => ({
  variant: { path: "Social/Posts/LinkedIn.md", platform: "linkedin", channels: ["li/ada"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
  channel: channel("li/ada", { handle: "urn:li:person:abc123", method: "api", secretId: "li-token" }),
  delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW, sendKey: "linkedin-send-key" },
  text: "Hello LinkedIn", items: ["Hello LinkedIn"], body: "Hello LinkedIn", media: [], secret: LINKEDIN_TOKEN,
});

export const linkedinCase: ContractCase = {
  platform: "linkedin",
  job: linkedinJob,
  before: [json(200, { sub: "abc123", name: "Ada Lovelace" })],
  success: {
    post: [json(201, {}, { "x-restli-id": LINKEDIN_POST_ID })],
    expect: { remoteId: LINKEDIN_POST_ID, url: `https://www.linkedin.com/feed/update/${LINKEDIN_POST_ID}` },
  },
  rateLimited: { post: [json(429, { message: "rate limited" }, { "retry-after": "30" })], retryAfterMs: 30_000 },
  authExpired: [json(401, { message: "expired" })],
  forbidden: [json(403, { message: "not permitted" })],
  rejected: [json(400, { message: "invalid post" })],
  serverError: { post: [json(500, { message: "server error" })], kind: "unknown" },
  sensitive: [LINKEDIN_TOKEN],
};
