import { json } from "../http";
import { channel } from "../fixtures";
import { CONTRACT_NOW, type ContractCase } from "../contract/harness";
import { BS, BS_ACCESS, BS_PASSWORD, BS_REFRESH, RATE_HEADERS, RKEY0, uriOf } from "./fixtures";

const job = () => ({
  variant: { path: "Social/Posts/Bs.md", platform: "bluesky" as const, channels: ["bs/you"], mode: "auto" as const, status: "scheduled" as const, media: [], deliveries: {} },
  channel: channel("bs/you", { handle: "@you.bsky.social", method: "api" as const, secretId: "osmm-channel-bs-you" }),
  delivery: { status: "publishing" as const, at: CONTRACT_NOW, attempts: 1 },
  text: "Doors open at 18:00",
  items: ["Doors open at 18:00"],
  body: "Doors open at 18:00",
  media: [],
  secret: BS_PASSWORD,
});

export const blueskyCase: ContractCase = {
  platform: "bluesky",
  job,
  before: [json(200, BS.session)],
  success: { post: [json(200, BS.created(RKEY0))], expect: { remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` } },
  rateLimited: { post: [json(429, BS.rateLimited, RATE_HEADERS)], retryAfterMs: 30_000 },
  // The token expired, the refresh token too, and logging in again is refused.
  authExpired: [json(400, BS.expired), json(400, BS.expired), json(401, BS.badLogin)],
  forbidden: [json(403, BS.takedown)],
  rejected: [json(400, BS.invalid)],
  // M5 P2: createRecord is retry-safe, because a retry first looks for the earlier attempt's post (findRecent, P6).
  serverError: { post: [json(502, BS.upstream)], kind: "transient" },
  sensitive: [BS_PASSWORD, BS_ACCESS, BS_REFRESH],
  lookup: {
    job: () => ({ ...job(), delivery: { status: "check_needed" as const, at: CONTRACT_NOW } }),
    found: [json(200, BS.session), json(200, BS.record(RKEY0))],
    expect: { published: true, remoteId: uriOf(RKEY0), url: `https://bsky.app/profile/you.bsky.social/post/${RKEY0}` },
    notFound: [json(200, BS.session), json(400, BS.notFound)],
    // getRecord by the deterministic rkey is an exact lookup (M5 P5).
    notFoundAnswer: "not_found",
  },
};
