import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, header, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpResponse } from "../http";
import { multipart } from "../multipart";
import { withLink } from "../text";
import type { DeliveryJob, PlatformAdapter, PublishResult, VerifyResult } from "../types";

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/;
/** Any webhook token, wherever it appears in text from the platform (M5 G4): the part after /webhooks/<id>/. */
const TOKEN_IN_TEXT_RE = /(webhooks(?:\/|%2F)\d+(?:\/|%2F))[\w-]{20,}/gi;

interface DcWebhook {
  id: string;
  name?: string | null;
  channel_id: string;
  guild_id?: string | null;
}
interface DcMessage {
  id: string;
  channel_id?: string;
}
interface DcError {
  message?: string;
  retry_after?: number;
  global?: boolean;
}

export interface DiscordWebhook {
  id: string;
  token: string;
  base: string;
}

export function parseWebhook(secret: string | null): DiscordWebhook | null {
  const m = WEBHOOK_RE.exec((secret ?? "").trim());
  if (!m) return null;
  const id = m[1]!;
  const token = m[2]!;
  return { id, token, base: `https://discord.com/api/v10/webhooks/${id}/${token}` };
}

/** `text` without the webhook URL: whole, URL-encoded, its token part, or anything shaped like a webhook token (M5 G4). */
export function redactWebhook(text: string, secret?: string): string {
  let out = text;
  if (secret) {
    const s = secret.trim();
    const token = parseWebhook(s)?.token ?? "";
    for (const x of [s, encodeURIComponent(s)]) if (x.length >= 8) out = out.split(x).join("[webhook URL]");
    for (const x of [token, encodeURIComponent(token)]) if (x.length >= 8) out = out.split(x).join("[token]");
  }
  return out.replace(TOKEN_IN_TEXT_RE, "$1[token]");
}

/** Discord's error body: its `message` is the text (never the request URL, which carries the webhook token). */
export function discordFailure(res: HttpResponse, secret?: string): ApiFailure {
  const body = parseJson(res.text) as DcError | null;
  const message = typeof body?.message === "string" ? redactWebhook(body.message, secret) : `HTTP ${res.status}`;
  if (res.status === 429) {
    // The body's retry_after is in seconds and may be fractional; without it (a Cloudflare 429) Retry-After is used.
    const global = body?.global === true || header(res.headers, "x-ratelimit-global") === "true" || header(res.headers, "x-ratelimit-scope") === "global";
    const text = global ? `${message} (global rate limit)` : message;
    if (typeof body?.retry_after === "number" && Number.isFinite(body.retry_after)) return { message: text, kind: "transient", retryAfterMs: Math.ceil(Math.max(0, body.retry_after) * 1000) };
    return { message: text, kind: "transient" };
  }
  if (res.status === 404) return { message: `${message}. The webhook was deleted; create a new one and save its URL as this channel's credential.`, kind: "needs_user" };
  return { message };
}

/**
 * Server channels through a webhook (#89). No lookup: a webhook message can only be fetched by the id the lost answer
 * carried. No hand-over: a webhook can't schedule. The execute is a commit that is not retry-safe (M5 P2).
 */
export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord" as const;
  /** Webhook id → its server and channel, to build the message link. */
  private readonly hooks = new Map<string, DcWebhook>();

  constructor(private readonly deps: AdapterDeps) {}

  /** A client whose error messages are redacted with this webhook URL (its token is in every request's path). */
  private api(secret: string): ApiClient {
    const { http, now, timeoutMs } = this.deps;
    return new ApiClient({ platform: "discord", http, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}), failure: (res) => discordFailure(res, secret) });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const hook = this.webhook(job.channel, job.secret);
    const api = this.api(job.secret!);
    const info = await this.info(api, hook);
    // allowed_mentions with no parse types: @everyone, @here, roles and users in the text never ping anyone.
    const payload: Record<string, unknown> = { content: withLink(job.text, job.variant.url), allowed_mentions: { parse: [] } };
    if (job.channel.postAsName) payload.username = job.channel.postAsName;
    if (job.channel.postAsAvatar) payload.avatar_url = job.channel.postAsAvatar;
    const images = job.media.filter((m) => m.kind === "image");
    let res: HttpResponse;
    if (!images.length) {
      res = await api.commit({ url: `${hook.base}?wait=true`, method: "POST", contentType: "application/json", body: JSON.stringify(payload) });
    } else {
      const files = await Promise.all(images.map((m) => readMedia((p) => this.deps.readBinary(p), m)));
      payload.attachments = images.map((m, i) => ({ id: i, filename: fileName(m), ...(m.alt ? { description: m.alt.slice(0, 1024) } : {}) }));
      const form = multipart([
        { name: "payload_json", value: JSON.stringify(payload) },
        ...images.map((m, i) => ({ name: `files[${i}]`, filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data: files[i]! })),
      ]);
      res = await api.commit({ url: `${hook.base}?wait=true`, method: "POST", contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    }
    const msg = parseJson(res.text) as Partial<DcMessage> | null;
    if (typeof msg?.id !== "string" || !msg.id) throw new UnknownOutcomeError("Discord: the answer had no message id, so it is not known whether the post went out.");
    const channel = typeof msg.channel_id === "string" ? msg.channel_id : info.channel_id;
    return { remoteId: msg.id, url: `https://discord.com/channels/${info.guild_id ?? "@me"}/${channel}/${msg.id}` };
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const hook = this.webhook(channel, secret);
      const api = this.api(secret!);
      const res = await api.read({ url: hook.base, method: "GET" }).catch(() => {
        throw new Error("Couldn't reach Discord.");
      });
      if (!isOk(res)) throw api.error(res, { phase: "prepare" });
      const info = parseJson(res.text) as DcWebhook | null;
      if (info?.channel_id) this.hooks.set(hook.id, info);
      return { ok: true, account: `webhook "${info?.name ?? hook.id}"` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private webhook(channel: Channel, secret: string | null): DiscordWebhook {
    if (!secret) throw new NeedsUserError(`Paste the webhook URL of ${channel.name} as its credential on this device (Discord: Server settings → Integrations → Webhooks).`);
    const hook = parseWebhook(secret);
    if (!hook) throw new NeedsUserError(`The credential of ${channel.name} is not a Discord webhook URL (https://discord.com/api/webhooks/…).`);
    return hook;
  }

  private async info(api: ApiClient, hook: DiscordWebhook): Promise<DcWebhook> {
    const cached = this.hooks.get(hook.id);
    if (cached) return cached;
    const res = await api.prepare({ url: hook.base, method: "GET" });
    const info = parseJson(res.text) as DcWebhook | null;
    if (typeof info?.channel_id !== "string") throw new NeedsUserError("Discord: the webhook's channel could not be read. Check the webhook URL.");
    this.hooks.set(hook.id, info);
    return info;
  }
}
