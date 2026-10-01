import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { isOk, parseJson, type HttpResponse } from "../http";
import type { InstagramBusiness, MetaPage } from "../meta/accounts";
import { MetaClient } from "../meta/client";
import type {
  DeliveryJob,
  PlatformAdapter,
  PublishResult,
  RemoteState,
  SyncChange,
  VerifyResult,
} from "../types";
import { AssistedOnlyInstagramMediaHost, validateInstagramMediaUrl, type InstagramMediaHost } from "./media";

const MAX_IMAGES = 10;
const MAX_POLLS = 30;
const POLL_MS = 1_000;
const FIELDS = "id,permalink,media_type,caption,children,timestamp,username";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function permalink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.instagram.com" && /^\/p\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Instagram Business and Creator image publishing through the shared Meta Graph client. */
export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "instagram" as const;
  private readonly meta: MetaClient;

  constructor(private readonly deps: AdapterDeps, private readonly host: InstagramMediaHost = new AssistedOnlyInstagramMediaHost()) {
    this.meta = new MetaClient(deps);
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const { account } = await this.target({ channel, secret });
      return { ok: true, account: `@${account.username}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Instagram connection could not be verified." };
    }
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const media = this.validateMedia(job);
    const { account } = await this.target(job);
    const children: string[] = [];
    for (const item of media) {
      const hosted = await this.hostMedia(job, item);
      const response = await this.post(`${account.id}/media`, job.secret!, {
        image_url: hosted.url,
        ...(media.length > 1 ? { is_carousel_item: true } : { caption: job.text }),
      }, "prepare");
      const id = object(parseJson(response.text))?.id;
      if (typeof id !== "string" || !/^\d+$/.test(id))
        throw new NeedsUserError("Instagram: Meta did not return an image container id; nothing was published.");
      children.push(id);
      await this.waitUntilReady(id, job.secret!);
    }
    let creationId = children[0]!;
    if (children.length > 1) {
      const response = await this.post(`${account.id}/media`, job.secret!, {
        media_type: "CAROUSEL",
        children,
        caption: job.text,
      }, "prepare");
      const id = object(parseJson(response.text))?.id;
      if (typeof id !== "string" || !/^\d+$/.test(id))
        throw new NeedsUserError("Instagram: Meta did not return a carousel container id; nothing was published.");
      creationId = id;
      await this.waitUntilReady(creationId, job.secret!);
    }
    const published = await this.post(`${account.id}/media_publish`, job.secret!, { creation_id: creationId }, "commit");
    const remoteId = object(parseJson(published.text))?.id;
    if (typeof remoteId !== "string" || !/^\d+$/.test(remoteId))
      throw new UnknownOutcomeError("Instagram: Meta did not confirm the published media id; check Instagram before retrying.");
    const state = await this.readMedia(remoteId, job.secret!);
    if (!state || !this.supportedRemote(state, remoteId, account.username) || !permalink(state.permalink))
      throw new UnknownOutcomeError("Instagram: the image may be published, but Meta did not confirm its permalink; check Instagram.");
    return { remoteId, url: state.permalink };
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    const id = job.delivery.remoteId;
    if (!id || !/^\d+$/.test(id)) return null;
    try {
      const { account } = await this.target(job);
      const state = await this.readMedia(id, job.secret!);
      if (!state || !this.supportedRemote(state, id, account.username) || !permalink(state.permalink)) return null;
      return { published: true, remoteId: id, url: state.permalink };
    } catch {
      return null;
    }
  }

  async update(job: DeliveryJob, change?: SyncChange): Promise<void> {
    if (change?.content === false) return;
    const { account } = await this.target(job);
    const id = job.delivery.remoteId;
    if (!id || !/^\d+$/.test(id))
      throw new NeedsUserError("Instagram: this post has no valid media id for the selected account.");
    const state = await this.readMedia(id, job.secret!);
    if (!state || !this.supportedRemote(state, id, account.username) || !permalink(state.permalink))
      throw new NeedsUserError("Instagram: the post could not be confirmed; nothing was changed.");
    const result = await this.post(id, job.secret!, { caption: job.text }, "commit");
    if (object(parseJson(result.text))?.success !== true)
      throw new UnknownOutcomeError("Instagram: Meta did not confirm the caption change; check Instagram.");
  }

  private async target(who: Pick<DeliveryJob, "channel" | "secret">): Promise<{ page: MetaPage; account: InstagramBusiness }> {
    if (who.channel.platform !== "instagram" || who.channel.kind !== "profile" || !/^\d+$/.test(who.channel.handle ?? ""))
      throw new NeedsUserError("Instagram: select a discovered professional account with image publishing permission, or use assisted publishing.");
    if (!who.secret?.trim()) throw new NeedsUserError("Instagram: add a Meta user access token on this device, or use assisted publishing.");
    const pages = await this.meta.listPages({ accessToken: who.secret });
    if (
      pages.some((page) => page.instagramBusinessAccountId) &&
      pages.every((page) => page.instagramContentPublishPermission !== "granted")
    )
      throw new NeedsUserError("Instagram: instagram_content_publish permission is not confirmed; grant it in Meta or use assisted publishing.");
    for (const page of pages) {
      if (page.instagramContentPublishPermission !== "granted") continue;
      const accounts = await this.meta.listInstagramBusinesses(page);
      const account = accounts.find((candidate) => candidate.id === who.channel.handle);
      if (account) return { page, account };
    }
    throw new NeedsUserError("Instagram: this professional account is unavailable to the token or lacks the Page CREATE_CONTENT task; rediscover accounts or use assisted publishing.");
  }

  private validateMedia(job: DeliveryJob) {
    if (job.media.length < 1 || job.media.length > MAX_IMAGES || job.media.some((item) => item.kind !== "image"))
      throw new InvalidContentError("Instagram: attach one to ten images; video is not supported.");
    for (const item of job.media) {
      if (item.width && item.height) {
        const ratio = item.width / item.height;
        if (ratio < 0.795 || ratio > 1.915)
          throw new InvalidContentError("Instagram: images must have an aspect ratio from 0.80:1 to 1.91:1.");
      }
    }
    return job.media;
  }

  private supportedRemote(state: Record<string, unknown>, id: string, username: string): boolean {
    return state.id === id && state.username === username &&
      (state.media_type === "IMAGE" || state.media_type === "CAROUSEL_ALBUM");
  }

  private async hostMedia(job: DeliveryJob, item: DeliveryJob["media"][number]) {
    const data = await readMedia((path) => this.deps.readBinary(path), item);
    const result = await this.host.create({
      name: fileName(item),
      mime: item.mime ?? "image/png",
      data,
    }, "");
    const url = validateInstagramMediaUrl(result.url);
    if (result.expiresAt !== undefined && (!Number.isFinite(result.expiresAt) || result.expiresAt <= this.deps.now()))
      throw new NeedsUserError("Instagram: the hosted image URL has expired; refresh it or use assisted publishing.");
    return { url };
  }

  private async waitUntilReady(id: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const state = object(await this.meta.get(id, token, { fields: "id,status_code" }));
      if (state?.id !== id) throw new NeedsUserError("Instagram: Meta returned an unreadable image-processing state.");
      if (state.status_code === "FINISHED") return;
      if (state.status_code === "ERROR" || state.status_code === "EXPIRED")
        throw new InvalidContentError("Instagram: Meta could not process an image; check its format and dimensions.");
      if (state.status_code !== "IN_PROGRESS" && state.status_code !== "PENDING")
        throw new NeedsUserError("Instagram: Meta returned an unknown image-processing state; use assisted publishing.");
      if (attempt + 1 < MAX_POLLS) await this.deps.sleep(POLL_MS);
    }
    throw new NeedsUserError("Instagram: image processing took too long; check Instagram before trying again.");
  }

  private async readMedia(id: string, token: string): Promise<Record<string, unknown> | null> {
    const response = await this.meta.request(id, token, { phase: "read", method: "GET", query: { fields: FIELDS } });
    return isOk(response) ? object(parseJson(response.text)) : null;
  }

  private post(path: string, token: string, body: Record<string, unknown>, phase: "prepare" | "commit"): Promise<HttpResponse> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) form.set(key, value.join(","));
      else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        form.set(key, String(value));
    }
    return this.meta.request(path, token, {
      phase,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form.toString(),
      retrySafe: false,
    });
  }

}
