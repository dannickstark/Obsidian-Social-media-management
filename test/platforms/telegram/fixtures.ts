import { CONTRACT_NOW } from "../contract/harness";

export const TG_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

const chat = { id: -1001234567890, title: "Event X", username: "eventx", type: "channel" };
const privateChat = { id: -1009876543210, title: "Private news", type: "channel" };
const date = Math.floor(CONTRACT_NOW / 1000);
const message = (id: number, extra: Record<string, unknown> = {}) => ({ message_id: id, sender_chat: chat, chat, date, ...extra });

/** Bot API answers: `{ ok, result }` on success, `{ ok: false, error_code, description, parameters? }` on failure. */
export const TG = {
  sendMessage: { ok: true, result: message(42, { text: "Doors open at 18:00" }) },
  sendMessagePrivate: { ok: true, result: { message_id: 7, sender_chat: privateChat, chat: privateChat, date, text: "Doors open" } },
  sendPhoto: { ok: true, result: message(43, { photo: [{ file_id: "AgACAgQAAx0", file_unique_id: "AQAD", width: 1080, height: 1080, file_size: 8 }], caption: "Doors open" }) },
  sendMediaGroup: { ok: true, result: [message(44, { media_group_id: "1370", photo: [] }), message(45, { media_group_id: "1370", photo: [] }), message(46, { media_group_id: "1370", photo: [] })] },
  tooMany: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } },
  unauthorized: { ok: false, error_code: 401, description: "Unauthorized" },
  kicked: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
  tooLong: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
  chatNotFound: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
  badEntities: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0" },
  badGateway: { ok: false, error_code: 502, description: "Bad Gateway" },
  getMe: { ok: true, result: { id: 123456789, is_bot: true, first_name: "OSMM", username: "osmm_bot", can_join_groups: true } },
  getChat: { ok: true, result: { ...chat } },
  admin: { ok: true, result: { status: "administrator", user: { id: 123456789, is_bot: true, first_name: "OSMM" }, can_post_messages: true } },
  member: { ok: true, result: { status: "left", user: { id: 123456789, is_bot: true, first_name: "OSMM" } } },
  getUpdates: {
    ok: true,
    result: [
      { update_id: 1, my_chat_member: { chat, from: { id: 1, is_bot: false, first_name: "You" }, date, old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } } },
      { update_id: 2, channel_post: { message_id: 3, sender_chat: privateChat, chat: privateChat, date, text: "hi" } },
      { update_id: 3, channel_post: { message_id: 4, sender_chat: chat, chat, date, text: "again" } },
    ],
  },
  webhookConflict: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" },
};
