import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, header, parseJson, retryAfterMs, UPLOAD_TIMEOUT_MS, type HttpResponse } from "../http";
import type { DeliveryJob, PlatformAdapter, PublishResult, VerifyResult } from "../types";
import { LINKEDIN_API, linkedInHeaders, listLinkedInAccounts, type LinkedInAccountChoice } from "./accounts";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 9;
const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]+$/;
const ORGANIZATION_URN = /^urn:li:organization:\d+$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function failure(res: HttpResponse, token: string, now: number) {
  const body = object(parseJson(res.text));
  const raw = typeof body?.message === "string" ? body.message : typeof body?.serviceErrorCode === "number" ? `LinkedIn service error ${body.serviceErrorCode}` : `HTTP ${res.status}`;
  const message = raw.split(token).join("[secret]").split(encodeURIComponent(token)).join("[secret]");
  if (res.status === 429) {
    return { message: "rate limited", kind: "transient" as const, ...(retryAfterMs(res.headers, now) !== undefined ? { retryAfterMs: retryAfterMs(res.headers, now) } : {}) };
  }
  if (res.status === 401 || res.status === 403) return { message: "access is missing or expired; check LinkedIn product permissions or use assisted publishing", kind: "needs_user" as const };
  if (res.status === 400 || res.status === 413 || res.status === 422) return { message, kind: "invalid_content" as const };
  return { message: `LinkedIn: ${message}` };
}

function postUrl(id: string): string {
  return `https://www.linkedin.com/feed/update/${id}`;
}

/** LinkedIn publishing is disabled by default until app and permission access have been verified. */
export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = "linkedin" as const;
  constructor(private readonly deps: AdapterDeps) {}

  canPublish(kind: "profile" | "page"): boolean {
    return kind === "profile"
      ? this.deps.linkedInMemberAccessVerified === true
      : this.deps.linkedInCommunityManagementAccessVerified === true;
  }

  apiAvailable(channel: Channel): boolean {
    if (channel.platform !== "linkedin") return false;
    if (channel.kind === "profile") return this.canPublish("profile");
    if (channel.kind === "page") return this.canPublish("page");
    return false;
  }

  async findAccounts(secret: string | null): Promise<LinkedInAccountChoice[]> {
    if (!secret?.trim()) throw new NeedsUserError("LinkedIn: add an access token on this device, or use assisted publishing.");
    const access = this.deps.linkedInTokenAccess?.(secret);
    if (!access) throw new NeedsUserError("LinkedIn: access and granted scopes are not verified for this exact token. Reconnect or use assisted publishing.");
    return listLinkedInAccounts({
      accessToken: secret,
      grantedScopes: access.grantedScopes,
      signInWithLinkedInProductVerified: access.signInWithLinkedInProductVerified,
      communityManagementAccessVerified: this.deps.linkedInCommunityManagementAccessVerified === true,
    }, this.deps);
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const accounts = await this.findAccounts(secret);
      const account = accounts.find((item) => item.id === channel.handle && item.kind === channel.kind);
      if (!account) return { ok: false, error: "LinkedIn: the selected account does not match the authenticated member or an available organization. Rediscover accounts or use assisted publishing." };
      if (!this.canPublish(channel.kind === "page" ? "page" : "profile") || !account.canPublish)
        return { ok: false, error: `LinkedIn identity verified as ${account.name}; ${account.requiredPermission} and product access are not verified, so API publishing is disabled. Use assisted publishing.` };
      return { ok: true, account: account.name };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "LinkedIn connection could not be verified." };
    }
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const target = this.target(job.channel, job.secret);
    if (!this.canPublish(target.kind)) {
      const permission = target.kind === "profile" ? "w_member_social" : "w_organization_social and Community Management access";
      throw new NeedsUserError(`LinkedIn: API publishing is disabled until ${permission} and app access are verified. Use assisted publishing.`);
    }
    if (!job.secret?.trim()) throw new NeedsUserError("LinkedIn: add an access token on this device, or use assisted publishing.");
    const accounts = await this.findAccounts(job.secret);
    const account = accounts.find((item) => item.id === target.id && item.kind === target.kind);
    if (!account)
      throw new NeedsUserError("LinkedIn: the selected account does not match the member authenticated by this token or an available organization. Rediscover accounts or use assisted publishing.");
    if (!account.canPublish)
      throw new NeedsUserError(`LinkedIn: ${account.requiredPermission} and required product access are not verified for this token. Use assisted publishing.`);
    if (target.kind === "page" && account.kind !== "page")
      throw new NeedsUserError("LinkedIn: this organization is not confirmed as available for publishing by this member. Check its Community Management role or use assisted publishing.");
    if (job.text.trim().length === 0) throw new InvalidContentError("LinkedIn: post text is required.");
    if (job.media.length > MAX_IMAGES) throw new InvalidContentError(`LinkedIn: attach at most ${MAX_IMAGES} images.`);
    if (job.media.some((media) => media.kind !== "image" || (media.bytes !== undefined && media.bytes > IMAGE_MAX_BYTES)))
      throw new InvalidContentError("LinkedIn: attach images smaller than 8 MB, or use assisted publishing.");
    const api = this.api(job.secret);
    const imageIds: string[] = [];
    for (const media of job.media) imageIds.push(await this.upload(api, job, media));
    const content = imageIds.length === 1
      ? { media: { id: imageIds[0]!, title: fileName(job.media[0]!), ...(job.media[0]!.alt ? { altText: job.media[0]!.alt } : {}) } }
      : imageIds.length > 1
        ? { multiImage: { images: imageIds.map((id, index) => ({ id, ...(job.media[index]!.alt ? { altText: job.media[index]!.alt } : {}) })) } }
        : undefined;
    const body = {
      author: target.id,
      commentary: job.text,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    const response = await api.commit({
      url: `${LINKEDIN_API}/rest/posts`,
      method: "POST",
      headers: linkedInHeaders(job.secret),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    const remoteId = header(response.headers, "x-restli-id");
    if (!remoteId || !/^urn:li:(?:share|ugcPost):[A-Za-z0-9:_-]+$/.test(remoteId))
      throw new UnknownOutcomeError("LinkedIn: the post may have been published, but LinkedIn did not confirm its post id; check LinkedIn before retrying.");
    return { remoteId, url: postUrl(remoteId) };
  }

  private target(channel: Channel, secret: string | null): { id: string; kind: "profile" | "page" } {
    if (channel.platform !== "linkedin") throw new NeedsUserError("LinkedIn: select a LinkedIn account or organization, or use assisted publishing.");
    if (!secret?.trim()) throw new NeedsUserError("LinkedIn: add an access token on this device, or use assisted publishing.");
    if (channel.kind === "profile" && PERSON_URN.test(channel.handle ?? "")) return { id: channel.handle!, kind: "profile" };
    if (channel.kind === "page" && ORGANIZATION_URN.test(channel.handle ?? "")) return { id: channel.handle!, kind: "page" };
    throw new NeedsUserError("LinkedIn: select a discovered profile or organization with publishing access, or use assisted publishing.");
  }

  private api(token: string): ApiClient {
    return new ApiClient({
      platform: "linkedin",
      http: this.deps.http,
      now: this.deps.now,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      failure: (res) => failure(res, token, this.deps.now()),
    });
  }

  private async upload(api: ApiClient, job: DeliveryJob, media: DeliveryJob["media"][number]): Promise<string> {
    const owner = this.target(job.channel, job.secret).id;
    const initialized = await api.prepare({
      url: `${LINKEDIN_API}/rest/images?action=initializeUpload`,
      method: "POST",
      headers: linkedInHeaders(job.secret!),
      contentType: "application/json",
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });
    const value = object(object(parseJson(initialized.text))?.value);
    const uploadUrl = value?.uploadUrl;
    const imageId = value?.image;
    if (typeof uploadUrl !== "string" || typeof imageId !== "string" || !/^urn:li:image:[A-Za-z0-9_-]+$/.test(imageId))
      throw new NeedsUserError("LinkedIn: image upload could not be initialized; nothing was posted.");
    let parsedUrl: URL;
    try { parsedUrl = new URL(uploadUrl); } catch { throw new NeedsUserError("LinkedIn: image upload address was unreadable; nothing was posted."); }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.linkedin.com" || !parsedUrl.pathname.startsWith("/dms-uploads/"))
      throw new NeedsUserError("LinkedIn: image upload address was unexpected; nothing was posted.");
    const bytes = await readMedia((path) => this.deps.readBinary(path), media);
    if (bytes.byteLength > IMAGE_MAX_BYTES)
      throw new InvalidContentError("LinkedIn: images must be smaller than 8 MB.");
    await api.prepare({
      url: parsedUrl.toString(),
      method: "PUT",
      headers: { Authorization: `Bearer ${job.secret}`, "Content-Type": media.mime ?? "application/octet-stream" },
      body: bytes,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return imageId;
  }
}
