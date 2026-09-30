import { MINUTE } from "../../model/dates";
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { redactSecrets } from "../bluesky/api";
import { InvalidContentError, NeedsUserError, RemoteRemovedError, TransientError, UnknownOutcomeError } from "../errors";
import { fileName, readMedia } from "../files";
import { ApiClient, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse } from "../http";
import type { DeliveryJob, PlatformAdapter, PublishResult, RemoteState, ScheduleResult, SyncChange, VerifyResult } from "../types";
import { imageEmbeds, markdownToHtml } from "./markdown";

/** A future post needs a date after "now" on the site; one minute of margin (plus the hand-over margin). */
export const WP_MIN_LEAD_MS = MINUTE;
const CHECK_FAILED = "WordPress: could not check whether the earlier attempt went out; nothing was posted.";
const NEEDS_USER_CODES = new Set([
  "rest_post_invalid_id",
  "rest_cannot_edit",
  "rest_cannot_create",
  "rest_cannot_publish",
  "rest_cannot_assign_term",
  "rest_cannot_create_term",
  "rest_upload_user_quota_exceeded",
  "rest_forbidden",
  "rest_not_logged_in",
  "incorrect_password",
  "invalid_username",
  "invalid_email",
  "application_passwords_disabled",
]);
const ANY_STATUS = "publish,future,draft,pending,private";
const enc = encodeURIComponent;

interface WpPost {
  id: number;
  link: string;
  status: string;
  date_gmt?: string;
  modified_gmt?: string;
}

interface Target {
  site: string;
  apiRoot: string;
  host: string;
  auth: Record<string, string>;
  api: ApiClient;
}

interface Upload {
  path?: string;
  target: string;
  name: string;
  mime?: string;
  alt?: string;
}

/** WordPress dates without a zone, in UTC ("2026-10-08T15:30:00"). */
export const gmt = (at: number): string => new Date(at).toISOString().slice(0, 19);
const fromGmt = (s: string | undefined): number => (s ? Date.parse(`${s}Z`) : Number.NaN);
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** WordPress error messages and term names may contain HTML or entities. */
function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() || undefined;
}

function base64(s: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(s)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function wordpressFailure(res: HttpResponse, secrets: ReadonlyArray<string | null | undefined> = []): ApiFailure {
  const body = parseJson(res.text) as { code?: string; message?: string } | null;
  const message = redactSecrets(plainText(body?.message) ?? `HTTP ${res.status}`, secrets);
  if (body?.code && NEEDS_USER_CODES.has(body.code)) return { message, kind: "needs_user" };
  return { message };
}

function definitelyGone(res: HttpResponse): boolean {
  if (res.status === 410) return true;
  if (res.status !== 404) return false;
  return (parseJson(res.text) as { code?: unknown } | null)?.code === "rest_post_invalid_id";
}

/**
 * Articles through the REST API with an application password (#92): Markdown to HTML, local images uploaded to the
 * media library, categories and tags resolved or created, `status: future` hand-over, update, cancel and lookup.
 */
export class WordPressAdapter implements PlatformAdapter {
  readonly platform = "wordpress" as const;
  readonly minLeadMs = WP_MIN_LEAD_MS;
  /** "<site>\n<path>\n<bytes>" -> the uploaded media, for this session. */
  private readonly uploads = new Map<string, { id: number; url: string }>();
  /** "<site>\n<taxonomy>\n<name>" -> term id, for this session. */
  private readonly terms = new Map<string, number>();

  constructor(private readonly deps: AdapterDeps) {}

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const t = this.target(job);
    if (job.resume === true || (job.delivery.attempts ?? 1) > 1) {
      let earlier: RemoteState | null;
      try {
        earlier = await this.bySlug(t, job);
      } catch {
        throw new TransientError(CHECK_FAILED);
      }
      if (earlier?.published && earlier.remoteId && earlier.url) return { remoteId: earlier.remoteId, url: earlier.url };
    }
    const res = await t.api.commit(this.json(t, "/posts", await this.article(t, job, "publish")), { retrySafe: true });
    return this.posted(res);
  }

  async schedule(job: DeliveryJob): Promise<ScheduleResult> {
    const t = this.target(job);
    if (job.delivery.at === undefined) throw new InvalidContentError("WordPress: a scheduled article needs a time.");
    // Hand-over is not retry-safe: its fallback cannot de-duplicate against an answer lost after WordPress accepted it.
    const res = await t.api.commit(this.json(t, "/posts", await this.article(t, job, "future")));
    return this.posted(res);
  }

  async update(job: DeliveryJob, _change?: SyncChange): Promise<{ remoteId?: string }> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("WordPress: this article has no id to update.");
    const handedOver = job.delivery.status === "handed_over";
    const res = await t.api.exchange("commit", this.json(t, `/posts/${enc(id)}`, await this.article(t, job, handedOver ? "future" : undefined)));
    if (definitelyGone(res)) {
      if (handedOver) throw new RemoteRemovedError("WordPress: the article is no longer on the site (it was deleted there). It will be posted from Obsidian at its time.");
      throw new NeedsUserError("WordPress: the article is no longer on the site.");
    }
    if (!isOk(res)) throw t.api.error(res, { phase: "commit", retrySafe: true });
    return {};
  }

  async cancel(job: DeliveryJob): Promise<void> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("WordPress: this article has no id.");
    const current = await t.api
      .read({ url: `${t.apiRoot}/posts/${enc(id)}?context=edit&_fields=id,link,status,date_gmt`, method: "GET", headers: t.auth })
      .catch(() => {
        throw new TransientError("WordPress: couldn't reach the site; nothing was changed.");
      });
    if (definitelyGone(current)) return;
    if (!isOk(current)) throw t.api.error(current, { phase: "prepare" });
    if ((parseJson(current.text) as WpPost | null)?.status === "publish") {
      throw new NeedsUserError("WordPress: this article is already published. Unpublish it in WordPress if you want it gone.");
    }
    await t.api.commit(this.json(t, `/posts/${enc(id)}`, { status: "draft" }), { retrySafe: true });
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    try {
      const t = this.target(job);
      const id = job.delivery.remoteId;
      if (!id) return await this.bySlug(t, job);
      const res = await t.api.read({ url: `${t.apiRoot}/posts/${enc(id)}?context=edit&_fields=id,link,status,date_gmt`, method: "GET", headers: t.auth });
      if (definitelyGone(res)) return { published: false, gone: true };
      return isOk(res) ? this.state(parseJson(res.text) as WpPost | null) : null;
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const t = this.target({ channel, secret });
      const res = await t.api
        .read({ url: `${t.apiRoot}/users/me?context=edit&_fields=id,name`, method: "GET", headers: t.auth })
        .catch(() => {
          throw new Error(`Couldn't reach ${t.host}.`);
        });
      if (res.status === 404) return { ok: false, error: `No WordPress REST API at ${t.site}/wp-json/. Check the site address.` };
      if (!isOk(res)) throw t.api.error(res, { phase: "prepare" });
      return { ok: true, account: `${(parseJson(res.text) as { name?: string } | null)?.name ?? channel.login ?? "user"} on ${t.host}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private client(secret: string, login: string): ApiClient {
    const { http, now, timeoutMs } = this.deps;
    return new ApiClient({
      platform: "wordpress",
      http,
      now,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      failure: (res) => wordpressFailure(res, [secret, base64(secret), base64(`${login}:${secret}`)]),
    });
  }

  private target(who: Pick<DeliveryJob, "channel" | "secret">): Target {
    const { channel, secret } = who;
    const site = channel.server;
    if (!site) throw new NeedsUserError(`Set the site address (https://…) of ${channel.name} in its channel settings.`);
    if (!site.startsWith("https://")) throw new NeedsUserError(`${channel.name}: WordPress needs an https:// site address; application passwords only work over HTTPS.`);
    if (!channel.login) throw new NeedsUserError(`Set the WordPress user name of ${channel.name} in its channel settings.`);
    if (!secret) throw new NeedsUserError(`Add an application password for ${channel.name} on this device (WordPress: Users → Profile → Application passwords).`);
    return {
      site,
      apiRoot: `${site}/wp-json/wp/v2`,
      host: new URL(site).host,
      auth: { Authorization: `Basic ${base64(`${channel.login}:${secret}`)}` },
      api: this.client(secret, channel.login),
    };
  }

  private json(t: Target, path: string, body: Record<string, unknown>): HttpRequest {
    return { url: `${t.apiRoot}${path}`, method: "POST", headers: t.auth, contentType: "application/json", body: JSON.stringify(body) };
  }

  private posted(res: HttpResponse): PublishResult {
    const p = parseJson(res.text) as Partial<WpPost> | null;
    if (!p?.id) throw new UnknownOutcomeError("WordPress: the answer had no post id, so it is not known whether the article went out.");
    return { remoteId: String(p.id), url: p.link ?? "" };
  }

  private state(p: WpPost | null): RemoteState | null {
    if (!p?.id) return null;
    const remoteId = String(p.id);
    if (p.status === "publish") return { published: true, remoteId, url: p.link };
    if (p.status === "future") {
      const at = fromGmt(p.date_gmt);
      return { published: false, remoteId, ...(Number.isFinite(at) ? { scheduledAt: at } : {}) };
    }
    return { published: false, remoteId, gone: true };
  }

  /** The post with the note's slug: exact-time for a hand-over, stable send-window for an immediate retry. */
  private async bySlug(t: Target, job: DeliveryJob): Promise<RemoteState | null> {
    const slug = job.variant.wordpress?.slug;
    if (!slug) return null;
    const res = await t.api.read({
      url: `${t.apiRoot}/posts?slug=${enc(slug)}&status=${ANY_STATUS}&context=edit&_fields=id,link,status,date_gmt,modified_gmt`,
      method: "GET",
      headers: t.auth,
    });
    if (!isOk(res)) throw t.api.error(res, { phase: "prepare" });
    const posts = (parseJson(res.text) as WpPost[] | null) ?? [];
    const d = job.delivery;
    const retrying = job.resume === true || (d.status === "publishing" && (d.attempts ?? 1) > 1);
    const since = retrying ? (d.sendAt ?? this.deps.now() - 30 * MINUTE) - 5 * MINUTE : (d.at ?? this.deps.now()) - 5 * MINUTE;
    const hit = d.remoteAt !== undefined ? posts.find((p) => fromGmt(p.date_gmt) === d.remoteAt) : posts.find((p) => fromGmt(p.modified_gmt) >= since);
    return hit ? this.state(hit) : { published: false };
  }

  private async article(t: Target, job: DeliveryJob, status?: "publish" | "future"): Promise<Record<string, unknown>> {
    const v = job.variant;
    const wp = v.wordpress;
    if (!v.title?.trim()) throw new InvalidContentError("WordPress: the article needs a title.");
    const embedded = imageEmbeds(job.body);
    const addresses = new Map<string, { src: string; alt?: string }>();
    for (const target of embedded) {
      const file = this.deps.resolveEmbed?.(target, v.path);
      if (!file) continue;
      const alt = v.mediaMeta?.[target]?.alt;
      const up = await this.upload(t, { path: file.path, target, name: file.name, mime: file.mime, ...(alt ? { alt } : {}) });
      addresses.set(target, { src: up.url, ...(alt ? { alt } : {}) });
    }
    let content = markdownToHtml(job.body, { image: (target) => addresses.get(target) ?? null });
    for (const m of job.media) {
      if (m.kind !== "image" || embedded.includes(m.target)) continue;
      const up = await this.upload(t, { path: m.path, target: m.target, name: fileName(m), mime: m.mime, ...(m.alt ? { alt: m.alt } : {}) });
      content += `\n<figure class="wp-block-image"><img src="${escapeAttr(up.url)}" alt="${escapeAttr(m.alt ?? "")}" /></figure>`;
    }
    const f = job.featured;
    const featured = f?.kind === "image" ? await this.upload(t, { path: f.path, target: f.target, name: fileName(f), mime: f.mime, ...(f.alt ? { alt: f.alt } : {}) }) : null;
    const categories = await this.termIds(t, "categories", wp?.categories ?? []);
    const tags = await this.termIds(t, "tags", wp?.tags ?? []);
    return {
      title: v.title,
      content,
      ...(status ? { status } : {}),
      ...(status === "future" && job.delivery.at !== undefined ? { date_gmt: gmt(job.delivery.at) } : {}),
      ...(wp?.slug ? { slug: wp.slug } : {}),
      ...(wp?.excerpt ? { excerpt: wp.excerpt } : {}),
      categories,
      tags,
      ...(featured ? { featured_media: featured.id } : {}),
    };
  }

  private async upload(t: Target, f: Upload): Promise<{ id: number; url: string }> {
    const data = await readMedia((p) => this.deps.readBinary(p), f);
    const key = `${t.site}\n${f.path ?? f.target}\n${data.byteLength}`;
    const cached = this.uploads.get(key);
    if (cached) return cached;
    const name = f.name.replace(/[^\w.-]+/g, "-") || "image";
    const res = await t.api.prepare({
      url: `${t.apiRoot}/media`,
      method: "POST",
      headers: { ...t.auth, "Content-Disposition": `attachment; filename="${name}"` },
      contentType: f.mime ?? "application/octet-stream",
      body: data,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const media = parseJson(res.text) as { id?: number; source_url?: string } | null;
    if (!media?.id || !media.source_url) throw new TransientError("WordPress: the upload answer had no media id; nothing was posted.");
    if (f.alt) await t.api.prepare(this.json(t, `/media/${media.id}`, { alt_text: f.alt })).catch(() => undefined);
    const up = { id: media.id, url: media.source_url };
    this.uploads.set(key, up);
    return up;
  }

  private async termIds(t: Target, taxonomy: "categories" | "tags", names: readonly string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const key = `${t.site}\n${taxonomy}\n${name.toLowerCase()}`;
      let id = this.terms.get(key);
      if (id === undefined) {
        const res = await t.api.prepare({ url: `${t.apiRoot}/${taxonomy}?search=${enc(name)}&per_page=100&_fields=id,name`, method: "GET", headers: t.auth });
        const found = ((parseJson(res.text) as Array<{ id: number; name: string }> | null) ?? []).find(
          (term) => (plainText(term.name) ?? term.name).toLowerCase() === name.toLowerCase(),
        );
        id = found?.id ?? (await this.createTerm(t, taxonomy, name));
        this.terms.set(key, id);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private async createTerm(t: Target, taxonomy: "categories" | "tags", name: string): Promise<number> {
    const res = await t.api.exchange("prepare", this.json(t, `/${taxonomy}`, { name }));
    const body = parseJson(res.text) as { id?: number; code?: string; data?: { term_id?: number } } | null;
    if (isOk(res) && body?.id) return body.id;
    if (body?.code === "term_exists" && body.data?.term_id) return body.data.term_id;
    throw isOk(res)
      ? new TransientError("WordPress: the new category or tag has no id; nothing was posted.")
      : t.api.error(res, { phase: "prepare" });
  }
}
