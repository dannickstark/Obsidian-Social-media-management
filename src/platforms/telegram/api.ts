import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, partialOutcome, readMedia } from "../files";
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
const TOKEN_IN_TEXT_RE = /\d+(?::|%3A)[A-Za-z0-9_-]{30,}/gi;
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

/** `text` without the bot token: whole, its secret half, URL-encoded, or anything shaped like a token (M5 G4). */
export function redactToken(text: string, secret?: string): string {
  let out = text;
  if (secret) {
    const half = secret.split(":")[1] ?? "";
    for (const s of [secret, encodeURIComponent(secret), half, encodeURIComponent(half)]) if (s.length >= 8) out = out.split(s).join("[token]");
  }
  return out.replace(TOKEN_IN_TEXT_RE, "[token]");
}

/** The Bot API's error body: its `description` is the message (never the request URL, which carries the token). */
export function telegramFailure(res: HttpResponse, secret?: string): ApiFailure {
  const body = parseJson(res.text) as TgReply<unknown> | null;
  const message = typeof body?.description === "string" ? redactToken(body.description, secret) : `HTTP ${res.status}`;
  const migrated = body?.parameters?.migrate_to_chat_id;
  if (migrated) return { message: `${message}. The chat moved to ${migrated}; put that id in the channel's handle.`, kind: "needs_user" };
  const retry = body?.parameters?.retry_after;
  if (typeof retry === "number") return { message, retryAfterMs: retry * 1000 };
  if (res.status === 400 && NEEDS_USER_400.test(message)) return { message, kind: "needs_user" };
  return { message };
}

/** A sent message as the links need it: its id and its chat's id. */
function isMessage(m: unknown): m is TgMessage {
  const msg = m as Partial<TgMessage> | null;
  return typeof msg?.message_id === "number" && typeof msg.chat?.id === "number";
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

  constructor(private readonly deps: AdapterDeps) {}

  /** A client whose error messages are redacted with this token (it is in every request's path). */
  private api(token: string): ApiClient {
    const { http, now, timeoutMs } = this.deps;
    return new ApiClient({ platform: "telegram", http, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}), failure: (res) => telegramFailure(res, token) });
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
      // The same reading as a thread cut short (partialNote): anything that isn't a classified error may have gone out.
      const { kind, message } = partialOutcome(e);
      const [what, it] = images.length === 1 ? ["The photo was", "it"] : ["The photos were", "them"];
      const note = kind === "unknown" ? `${what} posted. The text after ${it} may have been posted; check on Telegram: ${message}` : `${what} posted, but the text after ${it} was not: ${message}`;
      return { ...this.result(first), note };
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
    const api = this.api(token);
    // No allowed_updates: Telegram stores it for the bot, which would change what other programs using it receive.
    const res = await api.read({ url: `${TELEGRAM_API}/bot${token}/getUpdates`, method: "POST", contentType: "application/json", body: JSON.stringify({ limit: 100 }) }).catch(() => {
      throw new Error("Telegram: the connection failed or no answer came in time.");
    });
    if (res.status === 409) {
      throw new Error("Telegram won't list this bot's chats here: it has a webhook, or another program is reading its updates. Enter the chat id by hand (@name or -100…).");
    }
    if (!isOk(res)) throw api.error(res, { phase: "prepare" });
    type Update = { channel_post?: { chat?: TgChat }; my_chat_member?: { chat?: TgChat }; message?: { chat?: TgChat } };
    const updates = (parseJson(res.text) as TgReply<Update[]> | null)?.result;
    if (!Array.isArray(updates)) throw new Error("Telegram: the answer could not be read.");
    const seen = new Map<string, TelegramChat>();
    for (const u of [...updates].reverse()) {
      const chat = u.my_chat_member?.chat ?? u.channel_post?.chat ?? u.message?.chat;
      if (!chat || typeof chat.id !== "number" || !["channel", "supergroup", "group"].includes(chat.type)) continue;
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
  private parsed<T>(res: HttpResponse, valid: (result: unknown) => result is T): T {
    const body = parseJson(res.text) as TgReply<unknown> | null;
    if (!body?.ok || !valid(body.result)) throw new UnknownOutcomeError("Telegram: the answer could not be read, so it is not known whether the post went out.");
    return body.result;
  }

  private async message(token: string, chatId: string, html: string): Promise<TgMessage> {
    const res = await this.api(token).commit({ url: `${TELEGRAM_API}/bot${token}/sendMessage`, method: "POST", contentType: "application/json", body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }) });
    return this.parsed(res, isMessage);
  }

  private async photo(token: string, chatId: string, m: MediaInfo, caption: string): Promise<TgMessage> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    const parts: Part[] = [{ name: "chat_id", value: chatId }];
    if (caption) parts.push({ name: "caption", value: caption }, { name: "parse_mode", value: "HTML" });
    parts.push({ name: "photo", filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data });
    const form = multipart(parts);
    const res = await this.api(token).commit({ url: `${TELEGRAM_API}/bot${token}/sendPhoto`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    return this.parsed(res, isMessage);
  }

  private async album(token: string, chatId: string, images: MediaInfo[], caption: string): Promise<TgMessage> {
    const files = await Promise.all(images.map((m) => readMedia((p) => this.deps.readBinary(p), m)));
    const media = images.map((_m, i) => ({ type: "photo", media: `attach://photo${i}`, ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}) }));
    const form = multipart([
      { name: "chat_id", value: chatId },
      { name: "media", value: JSON.stringify(media) },
      ...images.map((m, i) => ({ name: `photo${i}`, filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data: files[i]! })),
    ]);
    const res = await this.api(token).commit({ url: `${TELEGRAM_API}/bot${token}/sendMediaGroup`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const sent = this.parsed(res, (r): r is TgMessage[] => Array.isArray(r) && r.every(isMessage));
    if (!sent[0]) throw new UnknownOutcomeError("Telegram: the answer listed no messages, so it is not known whether the post went out.");
    return sent[0];
  }

  private async read<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
    const api = this.api(token);
    const res = await api.read({ url: `${TELEGRAM_API}/bot${token}/${method}`, method: "POST", contentType: "application/json", body: JSON.stringify(payload) }).catch(() => {
      throw new Error("Couldn't reach Telegram.");
    });
    if (!isOk(res)) throw api.error(res, { phase: "prepare" });
    const body = parseJson(res.text) as TgReply<T> | null;
    if (!body?.ok || body.result === undefined) throw new Error("Telegram sent an answer that could not be read.");
    return body.result;
  }
}
