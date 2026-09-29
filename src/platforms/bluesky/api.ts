import type { Channel } from "../../model/types";
import { cyrb53 } from "../../util/hash";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, TransientError, UnknownOutcomeError } from "../errors";
import { partialNote, readMedia } from "../files";
import { ApiClient, header, HTTP_TIMEOUT_MS, isOk, parseJson, send, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse, type Phase } from "../http";
import { isFetchable } from "../og";
import { urlsIn } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, VerifyResult } from "../types";
import { buildFacets } from "./richtext";
import { postRkey } from "./tid";

export const BSKY_SERVICE = "https://bsky.social";
/** app.bsky.embed.images / external thumb: at most 1,000,000 bytes per blob. */
export const BLOB_MAX = 1_000_000;
const POST = "app.bsky.feed.post";
const HOUR = 60 * 60_000;
const NEEDS_USER = new Set(["ExpiredToken", "InvalidToken", "AuthenticationRequired", "AccountTakedown", "AccountDeactivated", "AuthFactorTokenRequired"]);
/** Any JWT (a session token), wherever it appears in text from the platform (M5 G4). */
const JWT_IN_TEXT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const CHECK_FAILED = "Bluesky: could not check whether the earlier attempt went out; nothing was posted.";

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** Where the account's repository lives (from the DID document). */
  pds: string;
}
interface StrongRef {
  uri: string;
  cid: string;
}
interface Xrpc {
  path: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  json?: unknown;
  body?: ArrayBuffer;
  contentType?: string;
}
type Who = Pick<DeliveryJob, "channel" | "secret">;

/** `text` without the app password or a session token: whole, URL-encoded, or anything shaped like a JWT (M5 G4). */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const s of [secret, encodeURIComponent(secret)]) if (s.length >= 8) out = out.split(s).join("[secret]");
  }
  return out.replace(JWT_IN_TEXT_RE, "[secret]");
}

/**
 * The XRPC error body `{ error, message }`: its `message` is the text, redacted with `secrets()` (the app password and
 * the session tokens). A 429 waits until `ratelimit-reset` (epoch seconds); account and token errors need the user.
 */
export function blueskyFailure(now: () => number, secrets: () => ReadonlyArray<string | null | undefined> = () => []): (res: HttpResponse) => ApiFailure {
  return (res) => {
    const body = parseJson(res.text) as { error?: unknown; message?: unknown } | null;
    const error = typeof body?.error === "string" ? body.error : "";
    const raw = typeof body?.message === "string" ? body.message : error || `HTTP ${res.status}`;
    const message = redactSecrets(raw, secrets());
    if (res.status === 429) {
      const reset = Number(header(res.headers, "ratelimit-reset"));
      return { message, ...(Number.isFinite(reset) && reset > 0 ? { retryAfterMs: Math.max(0, reset * 1000 - now()) } : {}) };
    }
    if (NEEDS_USER.has(error)) return { message, kind: "needs_user" };
    return { message };
  };
}

function pdsOf(didDoc: unknown): string | null {
  const services = (didDoc as { service?: Array<{ id?: string; serviceEndpoint?: unknown }> } | null)?.service;
  const pds = Array.isArray(services) ? services.find((s) => s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds"))?.serviceEndpoint : undefined;
  return typeof pds === "string" && pds.startsWith("https://") ? pds.replace(/\/+$/, "") : null;
}

function expired(res: HttpResponse): boolean {
  if (res.status !== 400 && res.status !== 401) return false;
  const error = (parseJson(res.text) as { error?: string } | null)?.error;
  return error === "ExpiredToken" || error === "InvalidToken";
}

/**
 * Posts through the AT Protocol with an app password (#91). Record keys are derived from the claim time, so
 * lookup() finds an interrupted post exactly (M5 P5). The first post's createRecord is retry-safe (M5 P2): a retry
 * first looks for the earlier attempt's post, and fails closed when it can't tell (M5 P6). Sessions stay in memory
 * only (M5 G5).
 */
export class BlueskyAdapter implements PlatformAdapter {
  readonly platform = "bluesky" as const;
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: AdapterDeps) {}

  /** A client whose error messages are redacted with this channel's app password and session tokens. */
  private api(who: Who): ApiClient {
    const { http, now, timeoutMs } = this.deps;
    const secrets = () => {
      const s = this.sessions.get(this.key(who));
      return [who.secret, s?.accessJwt, s?.refreshJwt];
    };
    return new ApiClient({ platform: "bluesky", http, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}), failure: blueskyFailure(now, secrets) });
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const session = await this.session(job);
    if ((job.delivery.attempts ?? 1) > 1) {
      const earlier = await this.findRecent(job, session);
      if (earlier) return earlier;
    }
    const claimAt = job.delivery.at ?? this.deps.now();
    const root = await this.post(job, session, 0, claimAt);
    let parent = root;
    for (let i = 1; i < job.items.length; i++) {
      try {
        parent = await this.post(job, session, i, claimAt, { root, parent });
      } catch (e) {
        return { ...this.result(session, root.uri), note: partialNote(i, job.items.length, e) };
      }
    }
    return this.result(session, root.uri);
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    const at = job.delivery.at;
    if (at === undefined) return null;
    try {
      const s = await this.session(job);
      const rkey = postRkey(at, 0, job.channel.id);
      const res = await this.xrpc(job, "read", { path: "com.atproto.repo.getRecord", method: "GET", query: { repo: s.did, collection: POST, rkey } });
      if (isOk(res)) {
        const uri = (parseJson(res.text) as { uri?: unknown } | null)?.uri;
        return { published: true, ...this.result(s, typeof uri === "string" ? uri : `at://${s.did}/${POST}/${rkey}`) };
      }
      const error = (parseJson(res.text) as { error?: string } | null)?.error;
      return res.status === 400 && error === "RecordNotFound" ? { published: false } : null;
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const s = await this.session({ channel, secret });
      return { ok: true, account: `@${s.handle}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private result(s: Session, uri: string): { remoteId: string; url: string } {
    return { remoteId: uri, url: `https://bsky.app/profile/${s.handle}/post/${uri.split("/").pop() ?? ""}` };
  }

  private identity(who: Who): { identifier: string; password: string; service: string } {
    const identifier = (who.channel.handle ?? "").trim().replace(/^@/, "");
    if (!identifier) throw new NeedsUserError(`Set the handle of ${who.channel.name} to its Bluesky handle (you.bsky.social).`);
    if (!who.secret) throw new NeedsUserError(`Add an app password for ${who.channel.name} on this device (Bluesky: Settings → Privacy and security → App passwords).`);
    return { identifier, password: who.secret, service: who.channel.server ?? BSKY_SERVICE };
  }

  private key(who: Who): string {
    return `${who.channel.id}\n${cyrb53(who.secret ?? "")}`;
  }

  private async session(who: Who): Promise<Session> {
    const id = this.identity(who);
    const cached = this.sessions.get(this.key(who));
    if (cached) return cached;
    const res = await this.api(who).prepare({
      url: `${id.service}/xrpc/com.atproto.server.createSession`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ identifier: id.identifier, password: id.password }),
    });
    const s = this.parseSession(res, id.service);
    this.sessions.set(this.key(who), s);
    return s;
  }

  private parseSession(res: HttpResponse, fallbackPds: string): Session {
    const body = parseJson(res.text) as { did?: unknown; handle?: unknown; accessJwt?: unknown; refreshJwt?: unknown; didDoc?: unknown } | null;
    const { did, handle, accessJwt, refreshJwt } = body ?? {};
    if (typeof did !== "string" || !did || typeof accessJwt !== "string" || !accessJwt || typeof refreshJwt !== "string" || !refreshJwt) {
      throw new TransientError("Bluesky: the login answer could not be read; nothing was posted.");
    }
    return { did, handle: typeof handle === "string" && handle ? handle : did, accessJwt, refreshJwt, pds: pdsOf(body?.didDoc) ?? fallbackPds };
  }

  /** ExpiredToken: refresh the session (a prepare request); when the refresh is refused, log in again. */
  private async refresh(who: Who, s: Session): Promise<Session> {
    const api = this.api(who);
    this.sessions.delete(this.key(who));
    // The old session's tokens stay redacted while the refresh answer is read (JWT_IN_TEXT_RE covers them too).
    const res = await api.exchange("prepare", { url: `${s.pds}/xrpc/com.atproto.server.refreshSession`, method: "POST", headers: { Authorization: `Bearer ${s.refreshJwt}` } });
    if (!isOk(res)) return this.session(who);
    const next = { ...this.parseSession(res, s.pds), pds: s.pds };
    this.sessions.set(this.key(who), next);
    return next;
  }

  private request(s: Session, call: Xrpc): HttpRequest {
    const query = call.query ? `?${new URLSearchParams(call.query).toString()}` : "";
    const req: HttpRequest = { url: `${s.pds}/xrpc/${call.path}${query}`, method: call.method, headers: { Authorization: `Bearer ${s.accessJwt}` } };
    if (call.json !== undefined) return { ...req, contentType: "application/json", body: JSON.stringify(call.json) };
    if (call.body) return { ...req, contentType: call.contentType ?? "application/octet-stream", body: call.body, timeoutMs: UPLOAD_TIMEOUT_MS };
    return req;
  }

  /** One XRPC call with the session; an expired token is refreshed and the call sent once more (it was refused, not processed). */
  private async xrpc(who: Who, phase: Phase, call: Xrpc): Promise<HttpResponse> {
    let s = await this.session(who);
    let res = await this.api(who).exchange(phase, this.request(s, call));
    if (expired(res)) {
      s = await this.refresh(who, s);
      res = await this.api(who).exchange(phase, this.request(s, call));
    }
    return res;
  }

  /**
   * One post of the thread. Only the first part's createRecord is retry-safe (M5 P2): a retry of the publish looks for
   * it first. A later part is never retried, so a 5xx there is an unknown outcome and the note says it may be out.
   */
  private async post(job: DeliveryJob, s: Session, i: number, claimAt: number, reply?: { root: StrongRef; parent: StrongRef }): Promise<StrongRef> {
    const text = job.items[i] ?? "";
    const record: Record<string, unknown> = { $type: POST, text, createdAt: new Date(this.deps.now()).toISOString() };
    const facets = await buildFacets(text, (handle) => this.resolveHandle(job, handle));
    if (facets.length) record.facets = facets;
    if (reply) record.reply = reply;
    if (i === 0) {
      const embed = await this.embed(job);
      if (embed) record.embed = embed;
    }
    const res = await this.xrpc(job, "commit", { path: "com.atproto.repo.createRecord", method: "POST", json: { repo: s.did, collection: POST, rkey: postRkey(claimAt, i, job.channel.id), record } });
    if (!isOk(res)) throw this.api(job).error(res, { phase: "commit", retrySafe: i === 0 });
    const ref = parseJson(res.text) as { uri?: unknown; cid?: unknown } | null;
    if (typeof ref?.uri !== "string" || !ref.uri || typeof ref.cid !== "string" || !ref.cid) {
      throw new UnknownOutcomeError("Bluesky: the answer had no record id, so it is not known whether the post went out.");
    }
    return { uri: ref.uri, cid: ref.cid };
  }

  /** Images when there are any (Bluesky shows one or the other), else the link card of the post's url or last link. */
  private async embed(job: DeliveryJob): Promise<Record<string, unknown> | null> {
    const images = job.media.filter((m) => m.kind === "image").slice(0, 4);
    if (images.length) {
      const list: Array<Record<string, unknown>> = [];
      for (const m of images) {
        list.push({ alt: m.alt ?? "", image: await this.upload(job, m), ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}) });
      }
      return { $type: "app.bsky.embed.images", images: list };
    }
    const url = job.variant.url ?? urlsIn(job.items.join("\n")).at(-1);
    if (!url || !this.deps.linkCard) return null;
    // A card that can't be fetched never blocks the post (review focus 5).
    const card = await this.deps.linkCard(url).catch(() => null);
    if (!card) return null;
    const thumb = card.image ? await this.thumb(job, card.image) : null;
    return { $type: "app.bsky.embed.external", external: { uri: card.url, title: card.title, description: card.description, ...(thumb ? { thumb } : {}) } };
  }

  private async upload(job: DeliveryJob, m: MediaInfo): Promise<unknown> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    if (data.byteLength > BLOB_MAX) throw new InvalidContentError(`Bluesky: ${m.target} is larger than 1 MB.`);
    return this.blob(job, data, m.mime ?? "application/octet-stream");
  }

  /** uploadBlob: a prepare request (the post doesn't exist yet), with the upload timeout. */
  private async blob(job: DeliveryJob, data: ArrayBuffer, mime: string): Promise<unknown> {
    const res = await this.xrpc(job, "prepare", { path: "com.atproto.repo.uploadBlob", method: "POST", body: data, contentType: mime });
    if (!isOk(res)) throw this.api(job).error(res, { phase: "prepare" });
    const blob = (parseJson(res.text) as { blob?: unknown } | null)?.blob;
    if (!blob) throw new TransientError("Bluesky: the upload answer had no blob; nothing was posted.");
    return blob;
  }

  /** The card's image as a blob; any failure means a card without an image. https public hosts only (SSRF guard). */
  private async thumb(job: DeliveryJob, imageUrl: string): Promise<unknown> {
    if (!isFetchable(imageUrl)) return null;
    try {
      const res = await send(this.deps.http, { url: imageUrl, method: "GET" }, this.deps.timeoutMs ?? HTTP_TIMEOUT_MS);
      const type = (header(res.headers, "content-type") ?? "").split(";")[0]!.trim();
      if (!isOk(res) || !type.startsWith("image/") || res.arrayBuffer.byteLength > BLOB_MAX) return null;
      return await this.blob(job, res.arrayBuffer, type);
    } catch {
      return null;
    }
  }

  private async resolveHandle(who: Who, handle: string): Promise<string | null> {
    try {
      const res = await this.xrpc(who, "read", { path: "com.atproto.identity.resolveHandle", method: "GET", query: { handle } });
      const did = isOk(res) ? (parseJson(res.text) as { did?: unknown } | null)?.did : null;
      return typeof did === "string" && did ? did : null;
    } catch {
      return null;
    }
  }

  /**
   * A retry (M5 P2): a post with the same first text from the last hour means an earlier attempt went out. The rkey
   * can't find it, because every claim writes a new `at`. When the check can't answer, nothing is posted (M5 P6).
   */
  private async findRecent(job: DeliveryJob, s: Session): Promise<PublishResult | null> {
    let res: HttpResponse;
    try {
      res = await this.xrpc(job, "read", { path: "com.atproto.repo.listRecords", method: "GET", query: { repo: s.did, collection: POST, limit: "10" } });
    } catch {
      throw new TransientError(CHECK_FAILED);
    }
    const records = isOk(res) ? (parseJson(res.text) as { records?: unknown } | null)?.records : undefined;
    if (!Array.isArray(records)) throw new TransientError(CHECK_FAILED);
    const since = this.deps.now() - HOUR;
    for (const r of records as Array<{ uri?: unknown; value?: { text?: unknown; createdAt?: unknown } } | null>) {
      const createdAt = r?.value?.createdAt;
      if (typeof r?.uri === "string" && r.value?.text === job.items[0] && typeof createdAt === "string" && Date.parse(createdAt) >= since) return this.result(s, r.uri);
    }
    return null;
  }
}
