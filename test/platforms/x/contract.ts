import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { json } from "../http";

export const X_TOKEN = "x-user-token-secret";
export const X_USER = { data: { id: "42", name: "Ada Lovelace", username: "ada" } };
export const X_ID = "1999999999999999999";
export const X_POST = { data: { id: X_ID, text: "Hello", created_at: new Date(CONTRACT_NOW).toISOString() } };

const job = () => ({
  variant: { path: "Social/Posts/X.md", platform: "x" as const, channels: ["x/ada"], mode: "auto" as const, status: "scheduled" as const, media: [], deliveries: {} },
  channel: channel("x/ada", { platform: "x", handle: "ada", method: "api" as const, secretId: "x-token" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" },
  text: "Hello",
  items: ["Hello"],
  body: "Hello",
  media: [],
  secret: X_TOKEN,
});

export const xCase: ContractCase = {
  platform: "x",
  job,
  before: [json(200, X_USER)],
  success: { post: [json(201, X_POST)], expect: { remoteId: X_ID, url: `https://x.com/ada/status/${X_ID}` } },
  rateLimited: { post: [json(429, { title: "Too Many Requests" }, { "retry-after": "30" })], retryAfterMs: 30_000 },
  authExpired: [json(401, { title: "Unauthorized", detail: "invalid token" })],
  forbidden: [json(403, { title: "Forbidden", detail: "not permitted" })],
  rejected: [json(400, { title: "Invalid Request", detail: "invalid text" })],
  serverError: { post: [json(500, { title: "Server Error" })], kind: "unknown" },
  sensitive: [X_TOKEN],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW, sendAt: CONTRACT_NOW, sendKey: "send-key-x-1" } }),
    found: [json(200, X_USER), json(200, { data: [{ id: X_ID, text: "Hello", author_id: "42", created_at: new Date(CONTRACT_NOW).toISOString() }] })],
    expect: { published: true, remoteId: X_ID, url: `https://x.com/ada/status/${X_ID}` },
    notFound: [json(200, X_USER), json(200, { data: [] })],
    notFoundAnswer: "unknown",
  },
};
