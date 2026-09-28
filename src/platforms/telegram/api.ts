import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { classifyError, NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpResponse } from "../http";
import { multipart, type Part } from "../multipart";
import { withLink } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, VerifyResult } from "../types";
import { telegramHtml, visibleLength } from "./html";

export const TELEGRAM_API = "https://api.telegram.org";
export const CAPTION_MAX = 1024;
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{5,})$/;
/** Anything shaped like a bot token, wherever it appears in text from the platform (M5 G4). */
const TOKEN_IN_TEXT_RE = /\d+:[A-Za-z0-9_-]{30,}/g;
const NEEDS_USER_400 = /chat not found|not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|bot was kicked|have no rights/i;

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
}
interface TgReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface TelegramChat {
  id: string;
  title: string;
  username?: string;
}

/** The Bot API's error body: its `description` is the message (never the request URL, which carries the token). */
export function telegramFailure(res: HttpResponse): ApiFailure {
  const body = parseJson(res.text) as TgReply<unknown> | null;
  const message = typeof body?.description === "string" ? body.description.replace(TOKEN_IN_TEXT_RE, "[token]") : `HTTP ${res.status}`;
  const migrated = body?.parameters?.migrate_to_chat_id;
  if (migrated) return { message: `${message}. The chat moved to ${migrated}; put that id in the channel's handle.`, kind: "needs_user" };
  const retry = body?.parameters?.retry_after;
  if (typeof retry === "number") return { message, retryAfterMs: retry * 1000 };
  if (res.status === 400 && NEEDS_USER_400.test(message)) return { message, kind: "needs_user" };
  return { message };
}

/** https://t.me/<username>/<id> for public channels, https://t.me/c/<internal id>/<id> for private ones. */
export function messageUrl(chat: TgChat, id: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${id}`;
  return `https://t.me/c/${String(chat.id).replace(/^-100/, "")}/${id}`;
}

/**
 * Channels through a bot that is an admin of the channel (#88). No lookup: the Bot API can't read a channel's
 * history. No hand-over: it can't schedule. Every send is a commit that is not retry-safe (M5 P2).
 */
export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram" as const;
  private readonly api: ApiClient;

  constructor(private readonly deps: AdapterDeps) {
    this.api = new ApiClient({ platform: "telegram", http: deps.http, now: deps.now, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), failure: telegramFailure });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const token = this.token(job.secret);
    const chatId = this.chatId(job.channel);
    const html = telegramHtml(withLink(job.text, job.variant.url));
    const images = job.media.filter((m) => m.kind === "image");
    if (!images.length) return this.result(await this.message(token, chatId, html));
    const fits = visibleLength(html) <= CAPTION_MAX;
    const caption = fits ? html : "";
    const first = images.length === 1 ? await this.photo(token, chatId, images[0]!, caption) : await this.album(token, chatId, images, caption);
    if (fits || !html) return this.result(first);
    // #88, M5 P14: a caption over 1024 characters is sent as a message right after the photos.
    try {
      return this.result(await this.message(token, chatId, html));
    } catch (e) {
      const err = classifyError(e);
      const what = images.length === 1 ? "The photo was" : "The photos were";
      return { ...this.result(first), note: `${what} posted, but the text after it ${err.kind === "unknown" ? "may not have been" : "was not"}: ${err.message}` };
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const token = this.token(secret);
      const chatId = this.chatId(channel);
      const me = await this.read<{ id: number; username?: string }>(token, "getMe", {});
      const chat = await this.read<TgChat>(token, "getChat", { chat_id: chatId });
      const member = await this.read<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: chatId, user_id: me.id });
      const title = chat.title ?? chatId;
      const admin = member.status === "creator" || (member.status === "administrator" && member.can_post_messages !== false);
      if (!admin) return { ok: false, error: `The bot is not an admin of ${title}. Add it as an administrator with permission to post messages.` };
      return { ok: true, account: `${title}, posting as @${me.username ?? "bot"}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Channel settings, "Find chat id": the channels the bot saw recently (added as admin, or a post in the channel). */
  async findChats(secret: string | null): Promise<TelegramChat[]> {
    const token = this.token(secret);
    const res = await this.api.read({ url: `${TELEGRAM_API}/bot${token}/getUpdates`, method: "POST", contentType: "application/json", body: JSON.stringify({ allowed_updates: ["channel_post", "my_chat_member"], limit: 100 }) });
    if (res.status === 409) throw new Error("This bot has a webhook, so Telegram won't list its chats here. Enter the chat id by hand (@name or -100…).");
    if (!isOk(res)) throw this.api.error(res, { phase: "prepare" });
    const updates = (parseJson(res.text) as TgReply<Array<{ channel_post?: { chat: TgChat }; my_chat_member?: { chat: TgChat } }>> | null)?.result ?? [];
    const seen = new Map<string, TelegramChat>();
    for (const u of [...updates].reverse()) {
      const chat = u.my_chat_member?.chat ?? u.channel_post?.chat;
      if (!chat || !["channel", "supergroup", "group"].includes(chat.type)) continue;
      const id = String(chat.id);
      if (!seen.has(id)) seen.set(id, { id, title: chat.title ?? id, ...(chat.username ? { username: chat.username } : {}) });
    }
    return [...seen.values()].sort((a, b) => Number(!a.username) - Number(!b.username));
  }

  private token(secret: string | null): string {
    if (!secret) throw new NeedsUserError("Add this channel's bot token on this device (Settings → Social Planner → Channels).");
    if (!TOKEN_RE.test(secret.trim())) throw new NeedsUserError("The saved Telegram credential doesn't look like a bot token (123456:ABC…). Paste the token from @BotFather.");
    return secret.trim();
  }

  private chatId(channel: Channel): string {
    const handle = (channel.handle ?? "").trim();
    if (!CHAT_ID_RE.test(handle)) throw new NeedsUserError(`Set the handle of ${channel.name} to the channel's chat id: @name for a public channel, -100… for a private one.`);
    return handle;
  }

  private result(msg: TgMessage): PublishResult {
    return { remoteId: String(msg.message_id), url: messageUrl(msg.chat, msg.message_id) };
  }

  /** A 2xx answer to a send that says nothing readable about the message is an unknown outcome (Task 2 carry). */
  private parsed<T>(res: HttpResponse): T {
    const body = parseJson(res.text) as TgReply<T> | null;
    if (!body?.ok || body.result === undefined) throw new UnknownOutcomeError("Telegram: the answer could not be read, so it is not known whether the post went out.");
    return body.result;
  }

  private async message(token: string, chatId: string, html: string): Promise<TgMessage> {
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendMessage`, method: "POST", contentType: "application/json", body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }) });
    return this.parsed<TgMessage>(res);
  }

  private async photo(token: string, chatId: string, m: MediaInfo, caption: string): Promise<TgMessage> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    const parts: Part[] = [{ name: "chat_id", value: chatId }];
    if (caption) parts.push({ name: "caption", value: caption }, { name: "parse_mode", value: "HTML" });
    parts.push({ name: "photo", filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data });
    const form = multipart(parts);
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendPhoto`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    return this.parsed<TgMessage>(res);
  }

  private async album(token: string, chatId: string, images: MediaInfo[], caption: string): Promise<TgMessage> {
    const files = await Promise.all(images.map((m) => readMedia((p) => this.deps.readBinary(p), m)));
    const media = images.map((_m, i) => ({ type: "photo", media: `attach://photo${i}`, ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}) }));
    const form = multipart([
      { name: "chat_id", value: chatId },
      { name: "media", value: JSON.stringify(media) },
      ...images.map((m, i) => ({ name: `photo${i}`, filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data: files[i]! })),
    ]);
    const res = await this.api.commit({ url: `${TELEGRAM_API}/bot${token}/sendMediaGroup`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const sent = this.parsed<TgMessage[]>(res);
    if (!sent[0]) throw new UnknownOutcomeError("Telegram: the answer listed no messages, so it is not known whether the post went out.");
    return sent[0];
  }

  private async read<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await this.api.read({ url: `${TELEGRAM_API}/bot${token}/${method}`, method: "POST", contentType: "application/json", body: JSON.stringify(payload) }).catch(() => {
      throw new Error("Couldn't reach Telegram.");
    });
    if (!isOk(res)) throw this.api.error(res, { phase: "prepare" });
    const body = parseJson(res.text) as TgReply<T> | null;
    if (!body?.ok || body.result === undefined) throw new Error("Telegram sent an answer that could not be read.");
    return body.result;
  }
}
