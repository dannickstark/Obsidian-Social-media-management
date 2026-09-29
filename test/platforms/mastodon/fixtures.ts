import { tid } from "../../../src/platforms/bluesky/tid";
import { CONTRACT_NOW } from "../contract/harness";

export const MA_TOKEN = "ZA-Yj3aBD8U8Cm7lKUp-lm9O9BmDgdhHzDeqsY8tlL0";
/** Thu 8 Oct 2026, 17:30 Berlin: the time posts are handed over for. */
export const MA_AT = Date.UTC(2026, 9, 8, 15, 30);
/** The delivery's send key (M5 P17b), written by the first claim: every part's Idempotency-Key comes from it. */
export const MA_KEY = tid(CONTRACT_NOW * 1000 + 321, 77);

const account = { id: "109000000000000001", username: "you", acct: "you", display_name: "You", url: "https://mastodon.social/@you" };

export const MA = {
  /** GET /api/v1/accounts/verify_credentials */
  account,
  /** POST /api/v1/statuses → Status */
  status: (id = "113258473000000001", text = "Doors open at 18:00", created = CONTRACT_NOW) => ({
    id,
    created_at: new Date(created).toISOString(),
    in_reply_to_id: null,
    sensitive: false,
    spoiler_text: "",
    visibility: "public",
    language: "en",
    uri: `https://mastodon.social/users/you/statuses/${id}`,
    url: `https://mastodon.social/@you/${id}`,
    content: `<p>${text}</p>`,
    media_attachments: [],
    mentions: [],
    tags: [],
    account,
  }),
  /** POST /api/v1/statuses with scheduled_at, GET /api/v1/scheduled_statuses/:id → ScheduledStatus */
  scheduled: (id = "3221", at = MA_AT, text = "Doors open at 18:00") => ({
    id,
    scheduled_at: new Date(at).toISOString(),
    params: { text, poll: null, media_ids: null, sensitive: null, spoiler_text: null, visibility: null, in_reply_to_id: null, language: null, application_id: 1, scheduled_at: null, idempotency: null, with_rate_limit: false },
    media_attachments: [],
  }),
  /** POST /api/v2/media → 200 MediaAttachment (processed) */
  media: {
    id: "22348641",
    type: "image",
    url: "https://files.mastodon.social/media_attachments/files/022/348/641/original/cover.png",
    preview_url: "https://files.mastodon.social/media_attachments/files/022/348/641/small/cover.png",
    remote_url: null,
    description: "Crowd at the door",
    meta: { focus: { x: -0.16, y: 0.69 } },
    blurhash: "UFBWY:8_0Jxv4mof",
  },
  /** POST /api/v2/media → 202 (still processing: url is null); GET /api/v1/media/:id → 206 until done */
  processing: { id: "22348642", type: "image", url: null, preview_url: null, description: null },
  invalidToken: { error: "The access token is invalid" },
  scope: { error: "This action is outside the authorized scopes" },
  tooLong: { error: "Validation failed: Text character limit of 500 exceeded" },
  tooSoon: { error: "Validation failed: Scheduled at The scheduled date must be at least 5 minutes in the future" },
  notFound: { error: "Record not found" },
  tooMany: { error: "Too many requests" },
  unavailable: { error: "Service Unavailable" },
};

/** Mastodon's rate-limit headers; the reset is an ISO time. */
export const MA_RATE = { "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": new Date(CONTRACT_NOW + 30_000).toISOString() };
