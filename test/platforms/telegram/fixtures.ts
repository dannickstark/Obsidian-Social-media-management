import { CONTRACT_NOW } from "../contract/harness";

export const TG_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

const chat = { id: -1001234567890, title: "Event X", username: "eventx", type: "channel" };
const privateChat = { id: -1009876543210, title: "Private news", type: "channel" };
const date = Math.floor(CONTRACT_NOW / 1000);
const message = (id: number, extra: Record<string, unknown> = {}) => ({ message_id: id, sender_chat: chat, chat, date, ...extra });
/** A sent photo comes back as its PhotoSize list, smallest first. */
const photo = (id: string) => [
  { file_id: `${id}-s`, file_unique_id: `${id}s`, width: 90, height: 90, file_size: 1210 },
  { file_id: `${id}-m`, file_unique_id: `${id}m`, width: 320, height: 320, file_size: 14230 },
  { file_id: `${id}-x`, file_unique_id: `${id}x`, width: 1080, height: 1080, file_size: 96512 },
];
const bot = { id: 123456789, is_bot: true, first_name: "OSMM", username: "osmm_bot" };

/** Bot API answers: `{ ok, result }` on success, `{ ok: false, error_code, description, parameters? }` on failure. */
export const TG = {
  sendMessage: { ok: true, result: message(42, { text: "Doors open at 18:00" }) },
  sendMessagePrivate: { ok: true, result: { message_id: 7, sender_chat: privateChat, chat: privateChat, date, text: "Doors open" } },
  sendPhoto: { ok: true, result: message(43, { photo: photo("AgACAgQAAx0"), caption: "Doors open" }) },
  sendMediaGroup: {
    ok: true,
    result: [
      message(44, { media_group_id: "13706478329", photo: photo("AgACAgQAAx1"), caption: "Three photos" }),
      message(45, { media_group_id: "13706478329", photo: photo("AgACAgQAAx2") }),
      message(46, { media_group_id: "13706478329", photo: photo("AgACAgQAAx3") }),
    ],
  },
  tooMany: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } },
  unauthorized: { ok: false, error_code: 401, description: "Unauthorized" },
  kicked: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
  tooLong: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
  chatNotFound: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
  badEntities: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0" },
  badGateway: { ok: false, error_code: 502, description: "Bad Gateway" },
  getMe: { ok: true, result: { ...bot, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } },
  getChat: { ok: true, result: { ...chat } },
  /** ChatMemberAdministrator in a channel. */
  admin: {
    ok: true,
    result: {
      status: "administrator",
      user: bot,
      can_be_edited: false,
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: true,
      can_manage_video_chats: true,
      can_restrict_members: true,
      can_promote_members: false,
      can_change_info: true,
      can_invite_users: true,
      can_post_stories: true,
      can_edit_stories: true,
      can_delete_stories: true,
      can_post_messages: true,
      can_edit_messages: true,
    },
  },
  /** ChatMemberLeft. */
  member: { ok: true, result: { status: "left", user: bot } },
  getUpdates: {
    ok: true,
    result: [
      { update_id: 1, my_chat_member: { chat, from: { id: 1, is_bot: false, first_name: "You" }, date, old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } } },
      { update_id: 2, channel_post: { message_id: 3, sender_chat: privateChat, chat: privateChat, date, text: "hi" } },
      { update_id: 3, channel_post: { message_id: 4, sender_chat: chat, chat, date, text: "again" } },
      { update_id: 4, message: { message_id: 9, from: { id: 1, is_bot: false, first_name: "You" }, chat: { id: 1, first_name: "You", type: "private" }, date, text: "/start" } },
    ],
  },
  webhookConflict: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" },
};
