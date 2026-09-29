import type { Channel } from "../../model/types";
import { cyrb53 } from "../../util/hash";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, UnknownOutcomeError } from "../errors";
import { partialNote, readMedia } from "../files";
import { ApiClient, header, HTTP_TIMEOUT_MS, isOk, parseJson, send, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse, type Phase } from "../http";
import { isFetchable } from "../og";
import { urlsIn } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, VerifyResult } from "../types";
import { buildFacets } from "./richtext";
import { postRkey, tidParts, TID_RE } from "./tid";

export const BSKY_SERVICE = "https://bsky.social";
/** app.bsky.embed.images / external thumb: at most 1,000,000 bytes per blob. */
export const BLOB_MAX = 1_000_000;
const POST = "app.bsky.feed.post";
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
    // Only strings of 8+ characters are replaced: a very short value (a stray test secret, "a") would otherwise blank
    // out ordinary words of the message. App passwords (19) and JWTs are far longer.
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

/**
 * The record key of each thread part: from the delivery's send key (M5 P17b; part i = root + i µs, same clock id).
 * A job without one (not claimed by the orchestrator) falls back to the claim time, as in Task 7.
 */
function partKeys(job: DeliveryJob, now: number): (i: number) => string {
  const root = job.delivery.sendKey;
  if (root && TID_RE.test(root)) return (i) => tidParts(root, i);
  const at = job.delivery.sendAt ?? job.delivery.at ?? now;
  return (i) => postRkey(at, i, job.channel.id);
}

function expired(res: HttpResponse): boolean {
  if (res.status !== 400 && res.status !== 401) return false;
  const error = (parseJson(res.text) as { error?: string } | null)?.error;
  return error === "ExpiredToken" || error === "InvalidToken";
}

/**
 * Posts through the AT Protocol with an app password (#91). Record keys come from the delivery's send key (M5 P17b),
 * which the first claim writes and every retry keeps: a retry asks for each part by its key before creating it, so
 * every createRecord is retry-safe (M5 P2), a thread resumes where it stopped, and lookup() is exact (M5 P5). A
 * check that can't answer posts nothing (M5 P6). Sessions stay in memory only (M5 G5).
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
    // M5 P17b: every record key comes from the send key (a random TID) the first claim wrote, the same on every attempt.
    const rkey = partKeys(job, this.deps.now());
    // A retry (or a re-send from failed) asks for each part by its key first: the earlier attempt may have stored it.
    const resume = (job.delivery.attempts ?? 1) > 1;
    const root = await this.post(job, session, 0, rkey(0), resume);
    let parent = root;
    for (let i = 1; i < job.items.length; i++) {
      try {
        parent = await this.post(job, session, i, rkey(i), resume, { root, parent });
      } catch (e) {
        // Refused for now (5xx, 429, a failed upload): the retry finds the parts already out and continues the thread.
        if (e instanceof PublishError && e.kind === "transient") {
          throw new TransientError(`Bluesky: part ${i + 1} of ${job.items.length} is not posted yet; the parts before it are, and the retry continues the thread: ${e.message}`, e.retryAfterMs);
        }
        return { ...this.result(session, root.uri), note: partialNote(i, job.items.length, e) };
      }
    }
    return this.result(session, root.uri);
  }

  /** Exact (M5 P5): the first part's record, under the stored send key, whichever attempt stored it (M5 P17b). */
  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    const sendKey = job.delivery.sendKey;
    if (!sendKey || !TID_RE.test(sendKey)) return null;
    try {
      const s = await this.session(job);
      const ref = await this.stored(job, s, sendKey);
      return ref ? { published: true, ...this.result(s, ref.uri) } : { published: false };
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
   * The record of part `i` under its key from the send key (M5 P17). On a retry the stored part is reused (a
   * RecordNotFound means it is created); so every createRecord is retry-safe (M5 P2), and a thread resumes where
   * it stopped.
   */
  private async post(job: DeliveryJob, s: Session, i: number, rkey: string, resume: boolean, reply?: { root: StrongRef; parent: StrongRef }): Promise<StrongRef> {
    if (resume) {
      const earlier = await this.stored(job, s, rkey);
      if (earlier) return earlier;
    }
    const text = job.items[i] ?? "";
    const record: Record<string, unknown> = { $type: POST, text, createdAt: new Date(this.deps.now()).toISOString() };
    const facets = await buildFacets(text, (handle) => this.resolveHandle(job, handle));
    if (facets.length) record.facets = facets;
    if (reply) record.reply = reply;
    if (i === 0) {
      const embed = await this.embed(job);
      if (embed) record.embed = embed;
    }
    const res = await this.xrpc(job, "commit", { path: "com.atproto.repo.createRecord", method: "POST", json: { repo: s.did, collection: POST, rkey, record } });
    if (!isOk(res)) {
      const error = this.api(job).error(res, { phase: "commit", retrySafe: true });
      // On a retry, a refused create may mean the record is there after all (the earlier attempt's): ask by its key.
      const found = resume ? await this.stored(job, s, rkey) : null;
      if (found) return found;
      throw error;
    }
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

  /**
   * The card's image as a blob; any failure means a card without an image. https public hosts only (SSRF guard).
   * Memory: requestUrl reads the whole answer before its size can be checked, so a huge og:image is downloaded in
   * full (bounded only by the timeout) and then dropped when it is over BLOB_MAX; it is never uploaded.
   */
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
   * The record under `rkey`: its strong ref when it is there, null on RecordNotFound. Any other answer, or none,
   * means "can't tell", and nothing is posted (M5 P6, fail-closed).
   */
  private async stored(job: DeliveryJob, s: Session, rkey: string): Promise<StrongRef | null> {
    let res: HttpResponse;
    try {
      res = await this.xrpc(job, "read", { path: "com.atproto.repo.getRecord", method: "GET", query: { repo: s.did, collection: POST, rkey } });
    } catch {
      throw new TransientError(CHECK_FAILED);
    }
    const body = parseJson(res.text) as { uri?: unknown; cid?: unknown; error?: unknown } | null;
    if (isOk(res) && typeof body?.uri === "string" && body.uri && typeof body.cid === "string" && body.cid) return { uri: body.uri, cid: body.cid };
    if (res.status === 400 && body?.error === "RecordNotFound") return null;
    throw new TransientError(CHECK_FAILED);
  }
}
