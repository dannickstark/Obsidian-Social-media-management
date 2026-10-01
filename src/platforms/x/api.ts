import type { Channel } from "../../model/types";
import { countChars } from "../../model/body";
import { cyrb53 } from "../../util/hash";
import type { AdapterDeps } from "../adapters";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, UnknownOutcomeError } from "../errors";
import { fileName, partialNote, readMedia } from "../files";
import { ApiClient, header, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpResponse } from "../http";
import { multipart } from "../multipart";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, VerifyResult } from "../types";

export const X_API = "https://api.x.com";
export const X_IMAGE_MAX = 5 * 1024 * 1024;
const enc = encodeURIComponent;

/** X shortens every URL to its configured t.co length before applying Unicode weights. */
export function xUrlLength(_url: string): number {
  return 23;
}

export function xWeightedLength(text: string): number {
  return countChars(text, "x-weighted");
}

interface Account { id: string; username: string; name: string }
interface Tweet { id: string; text: string; author_id?: string; created_at?: string; referenced_tweets?: Array<{ type: string; id: string }> }
type Who = Pick<DeliveryJob, "channel" | "secret">;

function failure(res: HttpResponse, now: () => number): ApiFailure {
  const body = parseJson(res.text) as { title?: unknown; detail?: unknown; type?: unknown; errors?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title : "";
  const detail = typeof body?.detail === "string" ? body.detail : "";
  const raw = `${title}${title && detail ? ": " : ""}${detail}` || `HTTP ${res.status}`;
  const apiTier = /tier|access level|endpoint.*available|subscription/i.test(raw);
  if (res.status === 429) {
    const retry = Number(header(res.headers, "retry-after"));
    const reset = Number(header(res.headers, "x-rate-limit-reset"));
    const retryAfterMs = Number.isFinite(retry) ? retry * 1000 : Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) : undefined;
    return { message: `rate limited${apiTier ? `: ${raw}` : ""}`, kind: "transient", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (res.status === 403 && apiTier) return { message: `API tier does not allow this X endpoint. ${raw} Assisted publishing is still available.`, kind: "needs_user" };
  return { message: raw };
}

function result(account: Account, id: string): PublishResult {
  return { remoteId: id, url: `https://x.com/${account.username}/status/${id}` };
}

function readAccount(body: unknown): Account | null {
  const data = (body as { data?: { id?: unknown; username?: unknown; name?: unknown } } | null)?.data;
  if (typeof data?.id !== "string" || typeof data.username !== "string") return null;
  return { id: data.id, username: data.username, name: typeof data.name === "string" ? data.name : data.username };
}

function readTweet(body: unknown): Tweet | null {
  const data = (body as { data?: { id?: unknown; text?: unknown } } | null)?.data;
  if (typeof data?.id !== "string" || typeof data.text !== "string") return null;
  return data as Tweet;
}

/** X's OAuth approval is account-owned: the user supplies an injected OAuth 2 user access token with tweet.write/media.write. */
export class XAdapter implements PlatformAdapter {
  readonly platform = "x" as const;
  private readonly accounts = new Map<string, Account>();

  constructor(private readonly deps: AdapterDeps) {}

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const account = await this.account({ channel, secret });
      return { ok: true, account: `@${account.username}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async publish(job: DeliveryJob): Promise<PublishResult> {
    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i] ?? "";
      if (xWeightedLength(item) > 280) throw new InvalidContentError(`X: part ${i + 1} is ${xWeightedLength(item)}/280 weighted characters.`);
    }
    const account = await this.account(job);
    const resume = job.resume === true || (job.delivery.attempts ?? 1) > 1;
    const known = resume ? await this.ownTweets(job, account).catch(() => null) : null;
    if (resume && known === null) throw new NeedsUserError("X: could not check whether an earlier thread part went out; nothing was posted. Test the connection and try again.");
    const matches = known ?? [];
    let parent: Tweet | undefined;
    let root: Tweet | undefined;
    if (matches.length) {
      const first = matches.find((tweet) => tweet.text === (job.items[0] ?? ""));
      if (first) { root = first; parent = first; }
    }
    if (root && root.text !== (job.items[0] ?? "")) throw new NeedsUserError("X: an earlier version of this thread is live; delete it there or mark it published.");
    if (resume && !root) throw new NeedsUserError("X: no exact copy of the earlier post could be confirmed in the account timeline. Check X before retrying, or use assisted publishing.");
    for (let i = 0; i < job.items.length; i++) {
      const text = job.items[i] ?? "";
      if (i > 0 && parent) {
        const existing = matches.find((tweet) => tweet.referenced_tweets?.some((r) => r.type === "replied_to" && r.id === parent!.id));
        if (existing) {
          if (existing.text !== text) throw new NeedsUserError("X: an earlier version of this thread is live; delete it there or mark it published.");
          parent = existing;
          continue;
        }
      }
      if (i === 0 && root) continue;
      try {
        if (!root && i === 0) {
          const mediaIds = await this.uploadAll(job);
          root = await this.post(job, { text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }, 0);
          parent = root;
        } else {
          if (!parent || !root) throw new UnknownOutcomeError("X: the earlier thread part could not be confirmed; check X before posting more.");
          parent = await this.post(job, { text, reply: { in_reply_to_tweet_id: parent.id } }, i);
        }
      } catch (e) {
        if (i > 0) {
          if (e instanceof PublishError && e.kind === "transient") throw new TransientError(`X: part ${i + 1} of ${job.items.length} is not posted yet; earlier parts are live and a retry will check them first: ${e.message}`, e.retryAfterMs);
          if (e instanceof NeedsUserError && /earlier version/.test(e.message)) throw e;
          return { ...result(account, root!.id), note: partialNote(i, job.items.length, e) };
        }
        throw e;
      }
    }
    if (!root) throw new UnknownOutcomeError("X: no post id was returned; check X before trying again.");
    return result(account, root.id);
  }

  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    try {
      const account = await this.account(job);
      const posts = await this.ownTweets(job, account);
      if (posts === null) return null;
      const root = posts.find((p) => p.text === (job.items[0] ?? ""));
      if (!root) return null; // Timeline matching is heuristic: absence is not proof that nothing was posted.
      if (job.items.length === 1) return { published: true, ...result(account, root.id) };
      let parent = root;
      for (const text of job.items.slice(1)) {
        const next = posts.find((p) => p.text === text && p.referenced_tweets?.some((r) => r.type === "replied_to" && r.id === parent.id));
        if (!next) return { published: false, note: "An earlier part of the X thread is live. Post again to continue the thread." };
        parent = next;
      }
      return { published: true, ...result(account, root.id) };
    } catch { return null; }
  }

  private key(who: Who): string { return `${who.channel.id}\n${cyrb53(who.secret ?? "")}`; }

  private api(secret: string | null): ApiClient {
    if (!secret) throw new NeedsUserError("Add an X OAuth user access token with tweet.write and media.write scopes on this device.");
    const { http, now, timeoutMs } = this.deps;
    return new ApiClient({ platform: "x", http, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}), failure: (res) => {
      const f = failure(res, now);
      const raw = f.message;
      return { ...f, message: raw.split(secret).join("[secret]").split(encodeURIComponent(secret)).join("[secret]") };
    } });
  }

  private async account(who: Who): Promise<Account> {
    const cached = this.accounts.get(this.key(who));
    if (cached) return cached;
    const api = this.api(who.secret);
    const res = await api.prepare({ url: `${X_API}/2/users/me`, method: "GET", headers: { Authorization: `Bearer ${who.secret}` } });
    const account = readAccount(parseJson(res.text));
    if (!account) throw new TransientError("X: the account lookup returned no user id; nothing was posted.");
    this.accounts.set(this.key(who), account);
    return account;
  }

  private async post(job: DeliveryJob, payload: Record<string, unknown>, part: number): Promise<Tweet> {
    const api = this.api(job.secret);
    const sendKey = job.delivery.sendKey;
    const headers = { Authorization: `Bearer ${job.secret}`, ...(sendKey ? { "Idempotency-Key": `osmm-${sendKey}-${part}` } : {}) };
    const res = await api.commit({ url: `${X_API}/2/tweets`, method: "POST", headers, contentType: "application/json", body: JSON.stringify(payload) });
    const tweet = readTweet(parseJson(res.text));
    if (!tweet) throw new UnknownOutcomeError("X: the answer had no post id, so it is not known whether it went out.");
    return tweet;
  }

  private async uploadAll(job: DeliveryJob): Promise<string[]> {
    const ids: string[] = [];
    for (const media of job.media.filter((m) => m.kind === "image").slice(0, 4)) ids.push(await this.upload(job, media));
    return ids;
  }

  private async upload(job: DeliveryJob, media: MediaInfo): Promise<string> {
    const bytes = await readMedia((path) => this.deps.readBinary(path), media);
    if (bytes.byteLength > X_IMAGE_MAX) throw new InvalidContentError(`X: ${media.target} is larger than 5 MB.`);
    const form = multipart([
      { name: "media", filename: fileName(media), contentType: media.mime ?? "application/octet-stream", data: bytes },
      { name: "media_category", value: "tweet_image" },
    ]);
    const api = this.api(job.secret);
    const res = await api.prepare({ url: `${X_API}/2/media/upload`, method: "POST", headers: { Authorization: `Bearer ${job.secret}` }, contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const id = (parseJson(res.text) as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== "string" || !id) throw new TransientError("X: the image upload answer had no media id; nothing was posted.");
    if (media.alt) {
      await api.prepare({ url: `${X_API}/2/media/metadata`, method: "POST", headers: { Authorization: `Bearer ${job.secret}` }, contentType: "application/json", body: JSON.stringify({ media_id: id, alt_text: { text: media.alt.slice(0, 1000) } }) });
    }
    return id;
  }

  private async ownTweets(job: DeliveryJob, account: Account): Promise<Tweet[] | null> {
    const api = this.api(job.secret);
    const res = await api.read({ url: `${X_API}/2/users/${enc(account.id)}/tweets?max_results=100&tweet.fields=created_at,author_id,referenced_tweets`, method: "GET", headers: { Authorization: `Bearer ${job.secret}` } });
    if (!isOk(res)) {
      if (res.status === 403) throw api.error(res, { phase: "prepare" });
      return null;
    }
    const data = (parseJson(res.text) as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    const since = job.delivery.sendAt ?? job.delivery.at;
    return data.filter((x): x is Tweet => {
      if (!x || typeof x !== "object" || typeof (x as Tweet).id !== "string" || typeof (x as Tweet).text !== "string") return false;
      const created = Date.parse((x as Tweet).created_at ?? "");
      // A lookalike from before this delivery is not evidence that this send happened.
      return since === undefined || (Number.isFinite(created) && created >= since - 30_000);
    });
  }
}
