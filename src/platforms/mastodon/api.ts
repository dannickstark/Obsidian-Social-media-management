import { MINUTE } from "../../model/dates";
import type { Channel } from "../../model/types";
import type { AdapterDeps } from "../adapters";
import { redactSecrets } from "../bluesky/api";
import { newSendKey, TID_RE } from "../bluesky/tid";
import { InvalidContentError, NeedsUserError, PublishError, RemoteRemovedError, ReplacementUnknownError, TransientError, UnknownOutcomeError } from "../errors";
import { fileName, partialNote, readMedia } from "../files";
import { ApiClient, header, isOk, parseJson, UPLOAD_TIMEOUT_MS, type ApiFailure, type HttpRequest, type HttpResponse } from "../http";
import { multipart, type Part } from "../multipart";
import { withLink } from "../text";
import type { DeliveryJob, MediaInfo, PlatformAdapter, PublishResult, RemoteState, ScheduleResult, SyncChange, VerifyResult } from "../types";

/** Mastodon refuses a scheduled_at less than 5 minutes ahead. */
export const MASTODON_MIN_LEAD_MS = 5 * MINUTE;
/**
 * Mastodon answers a repeated Idempotency-Key with the post it already made for an hour (3,600 s). Past this age
 * (five minutes of margin for clock skew) a resumed send can't count on it and checks the profile first.
 */
const KEY_WINDOW_MS = 55 * MINUTE;
const MEDIA_POLL_MS = 1_000;
const MEDIA_POLL_TRIES = 30;
const enc = encodeURIComponent;
const MIXED = "Mastodon: an earlier version of this post is partly live on Mastodon; delete it there or mark it published.";
const LIVE_LATE = "Mastodon: an earlier attempt at this post is live on Mastodon, and Mastodon only recognises a repeat within an hour; delete it there or mark it published.";
const CHECK_FAILED = "Mastodon: could not check whether the earlier attempt went out; nothing was posted.";
const MAYBE_REMOVED = "Mastodon: the old scheduled post may have been removed; nothing new was scheduled.";
const STILL_THERE = "Mastodon: the old scheduled post could not be removed, so nothing was changed. Try again.";
const GONE = "Mastodon: the post is no longer scheduled there (it went out, or it was deleted on Mastodon); nothing was changed.";

interface MaStatus {
  id: string;
  url?: string | null;
  uri: string;
  created_at: string;
  content: string;
  in_reply_to_id?: string | null;
  /** A boost: someone else's post, never taken for ours. */
  reblog?: unknown;
}
interface MaScheduled {
  id: string;
  scheduled_at: string;
  params?: { text?: string | null };
}
interface Target {
  base: string;
  auth: Record<string, string>;
  host: string;
  api: ApiClient;
  secret: string;
}

/**
 * Where the access token goes: the channel's `server`, else the exact host (and port) of an `@you@host` or
 * `https://host/@you` handle, never a guess (no `www.` stripping). Anything else is ambiguous: null, and the
 * channel needs its server address.
 */
export function mastodonBase(channel: Channel): string | null {
  if (channel.server) return channel.server;
  const handle = channel.handle?.trim() ?? "";
  const at = /^@?[^@\s/]+@([a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?)$/i.exec(handle);
  if (at) return `https://${at[1]!.toLowerCase()}`;
  if (!/^https:\/\/[^/]+\/@[^/@\s]+\/?$/i.test(handle)) return null;
  try {
    return `https://${new URL(handle).host}`;
  } catch {
    return null;
  }
}

/**
 * Mastodon's error body `{ error, error_description }`, redacted with `secrets()` (the access token, whole or
 * URL-encoded, M5 G4). A 429 waits until X-RateLimit-Reset (an ISO time).
 */
export function mastodonFailure(now: () => number, secrets: () => ReadonlyArray<string | null | undefined> = () => []): (res: HttpResponse) => ApiFailure {
  return (res) => {
    const body = parseJson(res.text) as { error?: unknown; error_description?: unknown } | null;
    const raw = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    const message = redactSecrets(raw, secrets());
    if (res.status === 429) {
      const reset = Date.parse(header(res.headers, "x-ratelimit-reset") ?? "");
      if (Number.isFinite(reset)) return { message, retryAfterMs: Math.max(0, reset - now()) };
    }
    return { message };
  };
}

/** Our focal point (0..1 from the left and from the top) → Mastodon's (-1..1, y pointing up). */
export function toMastodonFocus([x, y]: [number, number]): string {
  return `${(x * 2 - 1).toFixed(2)},${(1 - y * 2).toFixed(2)}`;
}

/**
 * The letters and digits of a post: how a post is recognised in a list (Mastodon returns HTML). Links and @mentions
 * are left out on both sides (M5 P5): Mastodon shows a remote mention as `@user`, and the link is appended.
 */
export function fingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/@[\p{L}\p{N}_.-]+(?:@[\p{L}\p{N}.-]+)?/gu, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function plain(html: string): string {
  return new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/p>/gi, " "), "text/html").body.textContent ?? "";
}

/**
 * Instance-specific posting with an access token (#90): immediate posts and threads, media with alt text and focus,
 * native hand-over with scheduled_at (single posts only), time and content updates, cancel, and lookup.
 *
 * Every part of an immediate post carries an Idempotency-Key from the delivery's send key (M5 P17b) and its index,
 * the same on every attempt: Mastodon answers a repeat with the post it already made, so the commit is retry-safe
 * (M5 P2), a thread resumes where it stopped, and a resumed part holding other text refuses (M5 P17c). A hand-over
 * carries no key and is not retry-safe: a 5xx there is an unknown outcome.
 */
export class MastodonAdapter implements PlatformAdapter {
  readonly platform = "mastodon" as const;
  readonly minLeadMs = MASTODON_MIN_LEAD_MS;

  constructor(private readonly deps: AdapterDeps) {}

  async publish(job: DeliveryJob): Promise<PublishResult> {
    const t = this.target(job);
    const resuming = job.resume === true || (job.delivery.attempts ?? 1) > 1;
    let checked = false;
    /**
     * Before each part's commit (so after the uploads, which can take minutes): once a resumed send is past the key
     * window, the parts still to send are looked for on the profile, once.
     */
    const lateCheck = async (from: number): Promise<void> => {
      if (!resuming || checked) return;
      const since = job.delivery.sendAt;
      if (since !== undefined && this.deps.now() - since < KEY_WINDOW_MS) return;
      checked = true;
      await this.refuseIfLive(t, this.texts(job).slice(from), since);
    };
    const key = this.partKeys(job);
    const mediaIds = await this.uploadAll(t, job);
    await lateCheck(0);
    const first = await this.status(t, key(0), resuming, { status: this.firstText(job), ...(mediaIds.length ? { media_ids: mediaIds } : {}) });
    let parent = first;
    for (let i = 1; i < job.items.length; i++) {
      try {
        await lateCheck(i);
        parent = await this.status(t, key(i), resuming, { status: job.items[i] ?? "", in_reply_to_id: parent.id });
      } catch (e) {
        // Refused for now (5xx, 429): the retry replays the parts already out under their keys and continues the thread.
        if (e instanceof PublishError && e.kind === "transient") {
          throw new TransientError(`Mastodon: part ${i + 1} of ${job.items.length} is not posted yet; the parts before it are, and the retry continues the thread: ${e.message}`, e.retryAfterMs);
        }
        if (e instanceof NeedsUserError && (e.message === MIXED || e.message === LIVE_LATE)) throw e;
        return { ...this.result(first), note: partialNote(i, job.items.length, e) };
      }
    }
    return this.result(first);
  }

  scheduleRefusal(job: DeliveryJob): string | null {
    return job.items.length > 1 ? "Mastodon can't schedule a thread, so this one is posted from Obsidian at its time." : null;
  }

  async schedule(job: DeliveryJob): Promise<ScheduleResult> {
    const refusal = this.scheduleRefusal(job);
    if (refusal) throw new InvalidContentError(`Mastodon: ${refusal}`);
    const at = job.delivery.at;
    if (at === undefined) throw new InvalidContentError("Mastodon: a scheduled post needs a time.");
    const t = this.target(job);
    const mediaIds = await this.uploadAll(t, job);
    const payload = { status: this.firstText(job), ...(mediaIds.length ? { media_ids: mediaIds } : {}), scheduled_at: new Date(at).toISOString() };
    // M5 P2: a hand-over is not retry-safe (a fallback publish can't de-duplicate against it), so a 5xx is unknown.
    const res = await t.api.commit(this.post(t, "/api/v1/statuses", payload));
    const s = parseJson(res.text) as Partial<MaScheduled> | null;
    if (!s?.id || !s.scheduled_at) throw new UnknownOutcomeError("Mastodon: the answer had no scheduled post id, so it is not known whether it was scheduled.");
    return { remoteId: s.id };
  }

  async update(job: DeliveryJob, change?: SyncChange): Promise<{ remoteId?: string }> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("Mastodon: this post has no id to update.");
    if (job.delivery.status === "handed_over") {
      const at = job.delivery.at;
      if (at === undefined) throw new InvalidContentError("Mastodon: a scheduled post needs a time.");
      if (change && !change.content) {
        const res = await t.api.exchange("commit", { url: `${t.base}/api/v1/scheduled_statuses/${enc(id)}`, method: "PUT", headers: t.auth, contentType: "application/json", body: JSON.stringify({ scheduled_at: new Date(at).toISOString() }) });
        if (res.status === 404) throw new NeedsUserError(GONE);
        if (!isOk(res)) throw t.api.error(res, { phase: "commit", retrySafe: true });
        this.expectId(res, "Mastodon: the answer had no scheduled post id, so it is not known whether the time was changed.");
        return {};
      }
      // Mastodon can't edit a scheduled post's text. Remove it first, so there are never two scheduled copies.
      await this.removeScheduled(t, id);
      try {
        return { remoteId: (await this.schedule(job)).remoteId };
      } catch (e) {
        // M5 P4: only a definite refusal means the platform has no copy; an unknown outcome may have scheduled it.
        if (e instanceof PublishError && e.kind !== "unknown") {
          throw new RemoteRemovedError(`Mastodon: the old scheduled post was removed, but the new one could not be scheduled (${e.message}). It will be posted from Obsidian at its time.`);
        }
        throw new ReplacementUnknownError(undefined, redactSecrets(e instanceof Error ? e.message : String(e), [t.secret]));
      }
    }
    if (job.items.length > 1) throw new InvalidContentError("Mastodon: only a single post can be edited, not a thread.");
    const mediaIds = await this.uploadAll(t, job);
    const res = await t.api.commit(
      { url: `${t.base}/api/v1/statuses/${enc(id)}`, method: "PUT", headers: t.auth, contentType: "application/json", body: JSON.stringify({ status: this.firstText(job), media_ids: mediaIds }) },
      { retrySafe: true },
    );
    this.expectId(res, "Mastodon: the answer had no post id, so it is not known whether the edit went out.");
    return {};
  }

  async cancel(job: DeliveryJob): Promise<void> {
    const t = this.target(job);
    const id = job.delivery.remoteId;
    if (!id) throw new NeedsUserError("Mastodon: this post has no scheduled id to remove.");
    const res = await t.api.exchange("commit", { url: `${t.base}/api/v1/scheduled_statuses/${enc(id)}`, method: "DELETE", headers: t.auth });
    if (res.status === 404) throw new NeedsUserError("Mastodon: the post is no longer scheduled there; it may have gone out already. Check Mastodon.");
    if (!isOk(res)) throw t.api.error(res, { phase: "commit", retrySafe: true });
  }

  /**
   * Exact by id for a handed-over post still on the schedule; otherwise a text search, which may confirm a post
   * but never says "not found" for an immediate publish (M5 P5). An interrupted hand-over that is nowhere answers
   * `{ published: false }`, which never fails a hand-over (M5 G11).
   */
  async lookup(job: DeliveryJob): Promise<RemoteState | null> {
    try {
      const t = this.target(job);
      const d = job.delivery;
      const text = this.firstText(job);
      if (d.remoteAt !== undefined) {
        if (d.remoteId) {
          const res = await t.api.read({ url: `${t.base}/api/v1/scheduled_statuses/${enc(d.remoteId)}`, method: "GET", headers: t.auth });
          if (isOk(res)) {
            const s = parseJson(res.text) as Partial<MaScheduled> | null;
            return { published: false, remoteId: d.remoteId, ...(s?.scheduled_at ? { scheduledAt: Date.parse(s.scheduled_at) } : {}) };
          }
          if (res.status !== 404) return null;
          // A scheduled post loses its id when it goes out: look for it among the published ones.
          const found = await this.findPublished(t, text, d.remoteAt);
          return found?.published ? found : null;
        }
        // An interrupted hand-over: look for it in the schedule, then among the published posts. Without letters or
        // digits to recognise it by, it can't tell.
        const want = fingerprint(text);
        if (want === "") return null;
        const res = await t.api.read({ url: `${t.base}/api/v1/scheduled_statuses?limit=40`, method: "GET", headers: t.auth });
        if (!isOk(res)) return null;
        const list = parseJson(res.text);
        const hit = (Array.isArray(list) ? (list as MaScheduled[]) : []).find((s) => Date.parse(s.scheduled_at) === d.remoteAt && fingerprint(s.params?.text ?? "") === want);
        if (hit) return { published: false, remoteId: hit.id, scheduledAt: Date.parse(hit.scheduled_at) };
        return await this.findPublished(t, text, d.remoteAt);
      }
      // An interrupted immediate publish: from the send's first claim, which a replayed key's post may date from.
      const since = d.sendAt ?? d.at;
      if (since === undefined) return null;
      const found = await this.findPublished(t, text, since);
      if (!found?.published || !found.remoteId) return null;
      return job.items.length > 1 ? await this.wholeThread(t, job, found) : found;
    } catch {
      return null;
    }
  }

  async verify(channel: Channel, secret: string | null): Promise<VerifyResult> {
    try {
      const t = this.target({ channel, secret });
      const res = await t.api.read({ url: `${t.base}/api/v1/accounts/verify_credentials`, method: "GET", headers: t.auth }).catch(() => {
        throw new Error(`Couldn't reach ${t.host}.`);
      });
      if (!isOk(res)) throw t.api.error(res, { phase: "prepare" });
      const acct = (parseJson(res.text) as { acct?: string } | null)?.acct ?? "";
      return { ok: true, account: `@${acct}@${t.host}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private target(who: Pick<DeliveryJob, "channel" | "secret">): Target {
    const base = mastodonBase(who.channel);
    if (!base) throw new NeedsUserError(`Set the handle of ${who.channel.name} to @you@your.instance (or set its server address).`);
    const secret = who.secret;
    if (!secret) throw new NeedsUserError(`Add an access token for ${who.channel.name} on this device (Mastodon: Preferences → Development → New application, scopes read and write).`);
    const { http, now, timeoutMs } = this.deps;
    const api = new ApiClient({ platform: "mastodon", http, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}), failure: mastodonFailure(now, () => [secret]) });
    return { base, auth: { Authorization: `Bearer ${secret}` }, host: new URL(base).host, api, secret };
  }

  /** The link goes on the first part only (Task 6 carry: checks.ts counts it there). */
  private firstText(job: DeliveryJob): string {
    return withLink(job.items[0] ?? "", job.variant.url);
  }

  /** Every part's text as sent: the link on the first part only. */
  private texts(job: DeliveryJob): string[] {
    return [this.firstText(job), ...job.items.slice(1)];
  }

  /**
   * Part i's Idempotency-Key: the send key and the index (M5 P17b), the same on every attempt of the send. A job
   * without one (not claimed by the orchestrator) gets a random key for this call only.
   */
  private partKeys(job: DeliveryJob): (i: number) => string {
    const stored = job.delivery.sendKey;
    const root = stored && TID_RE.test(stored) ? stored : newSendKey(this.deps.now());
    return (i) => `osmm-${root}-${i}`;
  }

  private post(t: Target, path: string, payload: Record<string, unknown>, key?: string): HttpRequest {
    return { url: `${t.base}${path}`, method: "POST", headers: { ...t.auth, ...(key ? { "Idempotency-Key": key } : {}) }, contentType: "application/json", body: JSON.stringify(payload) };
  }

  /**
   * One part, under its key (retry-safe, M5 P2). On a resumed send the answer may be the part an earlier attempt
   * made: it is kept only when it holds the text being sent now (M5 P17c, versions are never mixed).
   */
  private async status(t: Target, key: string, resuming: boolean, payload: { status: string } & Record<string, unknown>): Promise<MaStatus> {
    const res = await t.api.commit(this.post(t, "/api/v1/statuses", payload, key), { retrySafe: true });
    const s = parseJson(res.text) as Partial<MaStatus> | null;
    if (typeof s?.id !== "string" || !s.id) throw new UnknownOutcomeError("Mastodon: the answer had no post id, so it is not known whether it went out.");
    if (resuming && fingerprint(plain(s.content ?? "")) !== fingerprint(payload.status)) throw new NeedsUserError(MIXED);
    return s as MaStatus;
  }

  private expectId(res: HttpResponse, message: string): void {
    const body = parseJson(res.text) as { id?: unknown } | null;
    if (typeof body?.id !== "string" || !body.id) throw new UnknownOutcomeError(message);
  }

  private result(s: MaStatus): PublishResult {
    return { remoteId: s.id, url: s.url ?? s.uri };
  }

  private async uploadAll(t: Target, job: DeliveryJob): Promise<string[]> {
    const ids: string[] = [];
    for (const m of job.media.filter((x) => x.kind === "image").slice(0, 4)) ids.push(await this.upload(t, m));
    return ids;
  }

  private async upload(t: Target, m: MediaInfo): Promise<string> {
    const data = await readMedia((p) => this.deps.readBinary(p), m);
    const parts: Part[] = [{ name: "file", filename: fileName(m), contentType: m.mime ?? "application/octet-stream", data }];
    // Mastodon allows 1,500 characters of description; cut on a code point, never inside one.
    if (m.alt) parts.push({ name: "description", value: Array.from(m.alt).slice(0, 1500).join("") });
    if (m.focus) parts.push({ name: "focus", value: toMastodonFocus(m.focus) });
    const form = multipart(parts);
    const res = await t.api.prepare({ url: `${t.base}/api/v2/media`, method: "POST", headers: t.auth, contentType: form.contentType, body: form.body, timeoutMs: UPLOAD_TIMEOUT_MS });
    const media = parseJson(res.text) as { id?: unknown; url?: string | null } | null;
    if (typeof media?.id !== "string" || !media.id) throw new TransientError("Mastodon: the upload answer had no media id; nothing was posted.");
    if (res.status === 202 || !media.url) await this.processed(t, media.id);
    return media.id;
  }

  /** A large image is processed after the upload (202); the post may only use it once GET /media/:id answers 200. */
  private async processed(t: Target, id: string): Promise<void> {
    for (let i = 0; i < MEDIA_POLL_TRIES; i++) {
      await this.deps.sleep(MEDIA_POLL_MS);
      const res = await t.api.prepare({ url: `${t.base}/api/v1/media/${enc(id)}`, method: "GET", headers: t.auth });
      if (res.status === 200) return;
    }
    throw new TransientError("Mastodon: the image is still being processed; nothing was posted.");
  }

  /** Removes a scheduled post before a new version is scheduled. Never schedules again unless the old one is surely gone. */
  private async removeScheduled(t: Target, id: string): Promise<void> {
    const url = `${t.base}/api/v1/scheduled_statuses/${enc(id)}`;
    let res: HttpResponse | null = null;
    try {
      res = await t.api.exchange("commit", { url, method: "DELETE", headers: t.auth });
    } catch (e) {
      if (!(e instanceof UnknownOutcomeError)) throw e;
    }
    if (res && res.status === 404) throw new NeedsUserError(GONE);
    if (res && isOk(res)) return;
    if (res && res.status >= 400 && res.status < 500) throw t.api.error(res, { phase: "commit", retrySafe: true });
    // No answer, a 5xx or an odd answer: the removal may have happened. Ask for the old post before anything else.
    const check = await t.api.read({ url, method: "GET", headers: t.auth }).catch(() => null);
    if (check?.status === 404) return;
    if (check && isOk(check)) throw new TransientError(STILL_THERE);
    throw new ReplacementUnknownError(MAYBE_REMOVED);
  }

  /** The account's latest posts (40), or null when they can't be read. */
  private async recent(t: Target): Promise<MaStatus[] | null> {
    try {
      const me = await t.api.read({ url: `${t.base}/api/v1/accounts/verify_credentials`, method: "GET", headers: t.auth });
      const id = isOk(me) ? (parseJson(me.text) as { id?: unknown } | null)?.id : undefined;
      if (typeof id !== "string" || !id) return null;
      const res = await t.api.read({ url: `${t.base}/api/v1/accounts/${enc(id)}/statuses?limit=40&exclude_reblogs=true`, method: "GET", headers: t.auth });
      const list = isOk(res) ? parseJson(res.text) : null;
      return Array.isArray(list) ? (list as MaStatus[]).filter((s) => s.reblog === undefined || s.reblog === null) : null;
    } catch {
      return null;
    }
  }

  /** A text search (M5 P5): a post without letters or digits (images only, emoji only) can't be recognised: null. */
  private async findPublished(t: Target, text: string, since: number): Promise<RemoteState | null> {
    const want = fingerprint(text);
    if (want === "") return null;
    const list = await this.recent(t);
    if (!list) return null;
    const hit = list.find((s) => Date.parse(s.created_at) >= since - MINUTE && fingerprint(plain(s.content)) === want);
    return hit ? { published: true, remoteId: hit.id, url: hit.url ?? hit.uri } : { published: false };
  }

  /**
   * The rest of a thread whose first part was found: each later part must be a reply, with its text, to the one
   * before (from the root's context). All there: published. One missing: not published, with a note, so the
   * delivery stays failed with its send key. Anything it can't tell: null.
   */
  private async wholeThread(t: Target, job: DeliveryJob, root: RemoteState): Promise<RemoteState | null> {
    const wants = job.items.slice(1).map(fingerprint);
    if (wants.includes("")) return null;
    const res = await t.api.read({ url: `${t.base}/api/v1/statuses/${enc(root.remoteId ?? "")}/context`, method: "GET", headers: t.auth });
    const descendants = isOk(res) ? (parseJson(res.text) as { descendants?: unknown } | null)?.descendants : null;
    if (!Array.isArray(descendants)) return null;
    const total = job.items.length;
    let parent = root.remoteId;
    for (let i = 1; i < total; i++) {
      const next = (descendants as MaStatus[]).find((s) => s.in_reply_to_id === parent && fingerprint(plain(s.content ?? "")) === wants[i - 1]);
      if (!next) {
        return {
          published: false,
          note: `Part ${i} of ${total} is on Mastodon, part ${i + 1} and after are not. Post again posts the rest only within about 55 minutes of the first attempt; after that it is refused by design, so post the rest on Mastodon yourself and mark it published.`,
        };
      }
      parent = next.id;
    }
    return root;
  }

  /**
   * A resumed send past the key window (or of unknown age): Mastodon may have forgotten the keys, so a repeat could
   * post a part again. Any of `texts` (the parts still to send) found on the profile since the send began (any
   * time, without a send time) refuses; a check that can't answer posts nothing (M5 P6).
   */
  private async refuseIfLive(t: Target, texts: string[], since: number | undefined): Promise<void> {
    const list = await this.recent(t);
    if (!list) throw new TransientError(CHECK_FAILED);
    const parts = new Set(texts.map(fingerprint).filter((f) => f !== ""));
    const live = list.some((s) => (since === undefined || Date.parse(s.created_at) >= since - MINUTE) && parts.has(fingerprint(plain(s.content))));
    if (live) throw new NeedsUserError(LIVE_LATE);
  }
}
