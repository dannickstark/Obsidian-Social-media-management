import { MINUTE } from "../../model/dates";
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import {
  InvalidContentError,
  NeedsUserError,
  RemoteRemovedError,
  TransientError,
  UnknownOutcomeError,
} from "../errors";
import { fileName, readMedia } from "../files";
import { isOk, parseJson, UPLOAD_TIMEOUT_MS, type HttpResponse } from "../http";
import type { MetaPage } from "../meta/accounts";
import { MetaClient } from "../meta/client";
import { multipart } from "../multipart";
import type {
  DeliveryJob,
  PlatformAdapter,
  PublishResult,
  RemoteState,
  ScheduleResult,
  SyncChange,
  VerifyResult,
} from "../types";

export const FACEBOOK_MIN_LEAD_MS = 10 * MINUTE;
const FIELDS = "id,is_published,scheduled_publish_time,permalink_url,attachments";
export interface FacebookPageChoice {
  id: string;
  name: string;
  canPublish: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const postUrl = (id: string): string => `https://www.facebook.com/${id.replace("_", "/posts/")}`;

/** Supplied user tokens discover Page tokens; only the selected Page token is used for publishing. */
export class FacebookAdapter implements PlatformAdapter {
  readonly platform = "facebook" as const;
  readonly minLeadMs = FACEBOOK_MIN_LEAD_MS;
  private readonly meta: MetaClient;
  constructor(private readonly deps: AdapterDeps) {
    this.meta = new MetaClient(deps);
  }

  async findPages(secret: string | null): Promise<FacebookPageChoice[]> {
    const { pages, granted } = await this.accounts(secret);
    return pages.map((p) => ({
      id: p.id,
      name: p.name,
      canPublish: granted && p.tasks.includes("CREATE_CONTENT"),
    }));
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      return { ok: true, account: (await this.target({ channel, secret })).name };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Facebook connection could not be verified.",
      };
    }
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const page = await this.target(job);
    const body = await this.content(page, job);
    // Graph feed creates have no supported idempotency key. M5 parks every ambiguous commit in check_needed.
    return this.posted(await this.write(page, `${page.id}/feed`, body), page);
  }

  async schedule(job: DeliveryJob): Promise<ScheduleResult> {
    this.scheduleTime(job);
    const page = await this.target(job);
    const body = await this.content(page, job, true);
    const at = this.scheduleTime(job); // Uploads and discovery may have consumed the provider's lead time.
    return this.posted(
      await this.write(page, `${page.id}/feed`, {
        ...body,
        published: false,
        scheduled_publish_time: at,
        ...(job.media.length ? { unpublished_content_type: "SCHEDULED" } : {}),
      }),
      page,
    );
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    if (!job.delivery.remoteId) return null;
    try {
      const page = await this.target(job);
      const id = this.remoteId(job, page);
      const res = await this.read(page, id);
      // A Graph 404 is an explicit not-found response. Code 100/subcode 33 is ambiguous (including lost access).
      if (res.status === 404) return { published: false, gone: true };
      return isOk(res) ? this.state(object(parseJson(res.text)), id) : null;
    } catch {
      return null;
    }
  }

  async update(job: DeliveryJob, change?: SyncChange): Promise<void> {
    const page = await this.target(job);
    const id = this.remoteId(job, page);
    const res = await this.read(page, id);
    const scheduled = job.delivery.status === "handed_over";
    if (res.status === 404) {
      if (scheduled)
        throw new RemoteRemovedError(
          "Facebook: the scheduled post was removed from the Page. It will be posted from Obsidian at its time.",
        );
      throw new NeedsUserError("Facebook: this post is no longer on the Page.");
    }
    const current = isOk(res) ? object(parseJson(res.text)) : null;
    const state = this.state(current, id);
    if (!state)
      throw new NeedsUserError("Facebook: the post could not be checked; nothing was changed.");
    if (
      scheduled &&
      (state.published || state.scheduledAt === undefined || state.scheduledAt <= this.deps.now())
    )
      throw new NeedsUserError(
        "Facebook: this post is already published or due; check it on Facebook before editing.",
      );
    const body: Record<string, unknown> = {};
    if (change?.content !== false) {
      const attachments = object(current?.attachments)?.data;
      // Attachment replacement is not supported. Never acknowledge a full content sync after editing only its caption.
      if (job.media.length || job.variant.url || !Array.isArray(attachments) || attachments.length)
        throw new NeedsUserError(
          "Facebook: image and link edits require taking the scheduled post off Facebook and scheduling it again; edit live attachments on Facebook.",
        );
      body.message = job.text;
    }
    if (scheduled && change?.time !== false) body.scheduled_publish_time = this.scheduleTime(job);
    if (!Object.keys(body).length) return;
    this.acknowledged(await this.write(page, id, body, true));
  }

  async cancel(job: DeliveryJob): Promise<void> {
    const page = await this.target(job);
    const id = this.remoteId(job, page);
    const res = await this.read(page, id);
    if (res.status === 404) return;
    const state = isOk(res) ? this.state(object(parseJson(res.text)), id) : null;
    if (
      !state ||
      state.published ||
      state.scheduledAt === undefined ||
      state.scheduledAt < this.deps.now() + MINUTE
    )
      throw new NeedsUserError(
        "Facebook: cancellation requires a confirmed future post at least one minute away; check it on Facebook.",
      );
    this.acknowledged(
      await this.meta.request(id, page.accessToken, {
        phase: "commit",
        method: "DELETE",
        retrySafe: true,
      }),
    );
  }

  private async accounts(secret: string | null): Promise<{ pages: MetaPage[]; granted: boolean }> {
    if (!secret?.trim())
      throw new NeedsUserError(
        "Facebook: add a user access token on this device, or use assisted publishing.",
      );
    const pages = await this.meta.listPages({ accessToken: secret });
    const rows = await this.meta.list("me/permissions", secret, { fields: "permission,status" });
    const granted = ["pages_manage_posts", "pages_read_engagement"].every((permission) => {
      const matches = rows.map(object).filter((row) => row?.permission === permission);
      return matches.length === 1 && matches[0]?.status === "granted";
    });
    return { pages, granted };
  }

  private async target(who: Pick<DeliveryJob, "channel" | "secret">): Promise<MetaPage> {
    if (who.channel.kind !== "page" || !/^\d+$/.test(who.channel.handle ?? ""))
      throw new NeedsUserError(
        "Facebook: select a Facebook Page with a numeric Page id, or use assisted publishing.",
      );
    const { pages, granted } = await this.accounts(who.secret);
    const page = pages.find((p) => p.id === who.channel.handle);
    if (!page)
      throw new NeedsUserError(
        "Facebook: this Page is not available to the token; discover Pages again or use assisted publishing.",
      );
    if (!granted || !page.tasks.includes("CREATE_CONTENT"))
      throw new NeedsUserError(
        "Facebook: grant pages_manage_posts, pages_read_engagement and the Page CREATE_CONTENT task, or use assisted publishing.",
      );
    return page;
  }

  private scheduleTime(job: DeliveryJob): number {
    const at = job.delivery.at;
    if (
      at === undefined ||
      !Number.isFinite(at) ||
      Math.floor(at / 1000) * 1000 < this.deps.now() + this.minLeadMs
    )
      throw new InvalidContentError(
        "Facebook: native scheduling needs a time at least ten minutes ahead.",
      );
    return Math.floor(at / 1000);
  }

  private remoteId(job: DeliveryJob, page: MetaPage): string {
    const id = job.delivery.remoteId;
    if (!id || !new RegExp(`^${page.id}_\\d+$`).test(id))
      throw new NeedsUserError("Facebook: this post has no valid id for the selected Page.");
    return id;
  }

  private read(page: MetaPage, id: string): Promise<HttpResponse> {
    return this.meta.request(id, page.accessToken, {
      phase: "read",
      method: "GET",
      query: { fields: FIELDS },
    });
  }

  private write(
    page: MetaPage,
    path: string,
    body: Record<string, unknown>,
    retrySafe = false,
  ): Promise<HttpResponse> {
    return this.meta.request(path, page.accessToken, {
      phase: "commit",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      retrySafe,
    });
  }

  private posted(res: HttpResponse, page: MetaPage): PublishResult {
    const id = object(parseJson(res.text))?.id;
    if (typeof id !== "string" || !new RegExp(`^${page.id}_\\d+$`).test(id))
      throw new UnknownOutcomeError(
        "Facebook: the answer had no valid post id, so it is not known whether it went out.",
      );
    return { remoteId: id, url: postUrl(id) };
  }

  private acknowledged(res: HttpResponse): void {
    if (object(parseJson(res.text))?.success !== true)
      throw new UnknownOutcomeError(
        "Facebook: the answer did not confirm the change; check the post on Facebook.",
      );
  }

  private state(body: Record<string, unknown> | null, id: string): RemoteState | null {
    if (!body || body.id !== id) return null;
    if (body.is_published === true) return { published: true, remoteId: id, url: postUrl(id) };
    if (
      body.is_published === false &&
      typeof body.scheduled_publish_time === "number" &&
      Number.isFinite(body.scheduled_publish_time) &&
      body.scheduled_publish_time > 0
    )
      return { published: false, remoteId: id, scheduledAt: body.scheduled_publish_time * 1000 };
    return null;
  }

  private async content(
    page: MetaPage,
    job: DeliveryJob,
    scheduled = false,
  ): Promise<Record<string, unknown>> {
    if (job.media.length > 10 || job.media.some((m) => m.kind !== "image"))
      throw new InvalidContentError("Facebook: attach up to ten images; video is not supported.");
    if (job.media.length && job.variant.url)
      throw new InvalidContentError(
        "Facebook: image posts cannot also include a link. Remove the link or the images.",
      );
    if (!job.text.trim() && !job.variant.url && !job.media.length)
      throw new InvalidContentError("Facebook: add text, a link, or an image.");
    const attached: { media_fbid: string }[] = [];
    for (const m of job.media) {
      const data = await readMedia((path) => this.deps.readBinary(path), m);
      const form = multipart([
        { name: "published", value: "false" },
        ...(scheduled ? [{ name: "temporary", value: "true" }] : []),
        ...(m.alt ? [{ name: "alt_text_custom", value: m.alt }] : []),
        { name: "source", filename: fileName(m), contentType: m.mime ?? "image/png", data },
      ]);
      const res = await this.meta.request(`${page.id}/photos`, page.accessToken, {
        phase: "prepare",
        method: "POST",
        ...form,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      const id = object(parseJson(res.text))?.id;
      if (typeof id !== "string" || !/^\d+$/.test(id))
        throw new TransientError(
          "Facebook: the private image upload had no id; the feed post was not sent.",
        );
      attached.push({ media_fbid: id });
    }
    return {
      message: job.text,
      ...(attached.length
        ? { attached_media: attached }
        : job.variant.url
          ? { link: job.variant.url }
          : {}),
    };
  }
}
