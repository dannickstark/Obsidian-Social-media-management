export const DC_TOKEN = "Xk2d8sP3qLw9vN0tR5yU1aB7cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4yZ6";
export const DC_WEBHOOK = `https://discord.com/api/webhooks/1200000000000000001/${DC_TOKEN}`;

/** GET /webhooks/{id}/{token}: the webhook object (the token variant carries no user). */
const webhook = { type: 1, id: "1200000000000000001", name: "OSMM", avatar: null, channel_id: "1100000000000000002", guild_id: "1000000000000000003", application_id: null, token: DC_TOKEN };

export const DC = {
  webhook,
  /** POST /webhooks/{id}/{token}?wait=true: the created message. */
  message: {
    id: "1300000000000000004",
    type: 0,
    content: "Doors open at 18:00",
    channel_id: "1100000000000000002",
    author: { id: "1200000000000000001", username: "OSMM", bot: true },
    attachments: [],
    embeds: [],
    timestamp: "2026-10-08T08:00:00.000000+00:00",
    webhook_id: "1200000000000000001",
  },
  rateLimited: { message: "You are being rate limited.", retry_after: 1.5, global: false },
  globalRateLimited: { message: "You are being rate limited.", retry_after: 0.25, global: true },
  unauthorized: { message: "401: Unauthorized", code: 0 },
  unknownWebhook: { message: "Unknown Webhook", code: 10015 },
  missingPermissions: { message: "Missing Permissions", code: 50013 },
  invalidForm: { message: "Invalid Form Body", code: 50035, errors: { content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." }] } } },
  serverError: { message: "500: Internal Server Error", code: 0 },
};
