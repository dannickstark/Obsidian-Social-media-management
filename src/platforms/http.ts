import { requestUrl, type RequestUrlParam } from "obsidian";
import { PLATFORM_META, type Platform } from "../model/platforms";
import { withTimeout } from "../util/time";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, UnknownOutcomeError, type ErrorKind } from "./errors";

/** requestUrl has no timeout of its own (M3 final review 2). */
export const HTTP_TIMEOUT_MS = 30_000;
/** Requests that carry files: uploads, Telegram photos, Discord attachments. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** One HTTP exchange: resolves for every status, rejects when the connection fails. */
export type HttpFn = (req: RequestUrlParam) => Promise<HttpResponse>;

export interface HttpRequest extends RequestUrlParam {
  /** This request's own timeout (uploads); otherwise the client's. */
  timeoutMs?: number;
}

/** Obsidian's requestUrl (no CORS limits, works on phones), always with `throw: false`. */
export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({ ...req, throw: false });
  let text = "";
  try {
    text = res.text;
  } catch {
    // A binary body (an image) has no text.
  }
  return { status: res.status, headers: res.headers ?? {}, text, arrayBuffer: res.arrayBuffer };
};

export class RequestTimeoutError extends Error {
  constructor() {
    super("No answer in time.");
    this.name = "RequestTimeoutError";
  }
}

/** The connection failed (no HTTP answer). The message is fixed: requestUrl's own error may name the URL, which can carry a credential; it is kept as `cause` only. */
export class ConnectionFailedError extends Error {
  constructor(cause: unknown) {
    super("The connection failed.", { cause });
    this.name = "ConnectionFailedError";
  }
}

const TIMED_OUT = Symbol("timed out");

/**
 * Sends one request; a request with no answer within the timeout rejects with RequestTimeoutError, and a failed
 * connection with ConnectionFailedError.
 */
export async function send(http: HttpFn, req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
  const { timeoutMs: own, ...param } = req;
  let res: HttpResponse | typeof TIMED_OUT;
  try {
    res = await withTimeout(http({ ...param, throw: false }), own ?? timeoutMs, TIMED_OUT);
  } catch (e) {
    throw new ConnectionFailedError(e);
  }
  if (res === TIMED_OUT) throw new RequestTimeoutError();
  return res;
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const isOk = (res: HttpResponse): boolean => res.status >= 200 && res.status < 300;

/** Retry-After in seconds or as an HTTP date. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | undefined {
  const raw = header(headers, "retry-after");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Spec §5.3 by HTTP status; a platform's error body may say more (ApiFailure.kind). A commit's 5xx is decided by ApiClient.error (M5 P2). */
export function kindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "needs_user";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status === 400 || status === 413 || status === 422) return "invalid_content";
  return "needs_user";
}

export interface ApiFailure {
  /** Readable text from the platform's error body. Never the request URL or headers: they may carry the credential. */
  message: string;
  kind?: ErrorKind;
  retryAfterMs?: number;
}

/** prepare: before the post exists; commit: creates, changes or deletes it; read: lookups and connection tests. */
export type Phase = "prepare" | "commit" | "read";

/**
 * How to classify an HTTP answer that isn't 2xx: the phase of the request it answers. An adapter that classifies the
 * answer to a `read` (a lookup, a connection test) passes `{ phase: "prepare" }`: nothing was posted by it.
 */
export type ErrorPhase = { phase: "prepare" } | { phase: "commit"; retrySafe: boolean };

export interface CommitOptions {
  /**
   * M5 P2: a retry of this commit is exactly de-duplicated or idempotent (an Idempotency-Key, a de-dup check before
   * re-posting, a change to an existing object), so a 5xx answer may be retried. Default false: a 5xx is an unknown
   * outcome.
   */
  retrySafe?: boolean;
}

export interface ApiClientOptions {
  platform: Platform;
  http: HttpFn;
  now(): number;
  timeoutMs?: number;
  failure(res: HttpResponse): ApiFailure;
}

/**
 * The only way adapters talk to a platform (M2b P4, M5 P2). A failed connection before posting is transient (nothing
 * went out, retrying is safe); during the request that posts, it is an unknown outcome (check_needed, never
 * retried). HTTP errors are classified from the status and the platform's error body, except that a 5xx answer to a
 * commit that is not retry-safe is an unknown outcome: the platform may have accepted the post before failing.
 */
export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private get label(): string {
    return PLATFORM_META[this.opts.platform].label;
  }

  /** A request made before the post exists (login, upload, id lookups). */
  async prepare(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.exchange("prepare", req);
    if (!isOk(res)) throw this.error(res, { phase: "prepare" });
    return res;
  }

  /** The request that creates, changes or deletes the post. */
  async commit(req: HttpRequest, options: CommitOptions = {}): Promise<HttpResponse> {
    const res = await this.exchange("commit", req);
    if (!isOk(res)) throw this.error(res, { phase: "commit", retrySafe: options.retrySafe ?? false });
    return res;
  }

  /** Lookups and connection tests: every status comes back, and connection failures reject as they are. */
  read(req: HttpRequest): Promise<HttpResponse> {
    return this.exchange("read", req);
  }

  /** Like the phase's method, but HTTP errors come back to the caller (an expired session, a 404 that means "gone"). */
  async exchange(phase: Phase, req: HttpRequest): Promise<HttpResponse> {
    // Adapters request https:// addresses only (M5 G2); the address itself never goes into the message.
    if (!/^https:\/\//i.test(req.url)) throw new NeedsUserError(`${this.label}: only https:// addresses can be used; nothing was sent.`);
    try {
      return await send(this.opts.http, req, this.opts.timeoutMs ?? HTTP_TIMEOUT_MS);
    } catch (e) {
      if (phase === "read") throw e;
      const why = e instanceof RequestTimeoutError ? "no answer in time" : "the connection failed";
      if (phase === "prepare") throw new TransientError(`${this.label}: ${why} before posting; nothing was posted.`);
      throw new UnknownOutcomeError(`${this.label}: ${why} while posting, so it is not known whether it went out.`);
    }
  }

  /**
   * The classified error for an HTTP answer that isn't 2xx, for the phase of the request it answers (a `read` answer
   * counts as "prepare", see ErrorPhase). On a commit (M5 P2), a 5xx is an unknown outcome unless the commit is
   * retry-safe, and an answer below 400 (a redirect, status 0) is always an unknown outcome.
   */
  error(res: HttpResponse, at: ErrorPhase): PublishError {
    if (at.phase === "commit" && res.status < 400) {
      return new UnknownOutcomeError(`${this.label}: the server gave an unexpected answer (HTTP ${res.status}) while posting, so it is not known whether it went out.`);
    }
    if (at.phase === "commit" && !at.retrySafe && res.status >= 500) {
      return new UnknownOutcomeError(`${this.label}: the server answered with an error (HTTP ${res.status}) while posting, so it is not known whether it went out.`);
    }
    const f = this.failure(res);
    const message = `${this.label}: ${f.message} (HTTP ${res.status})`;
    switch (f.kind ?? kindForStatus(res.status)) {
      case "transient":
        return new TransientError(message, f.retryAfterMs ?? retryAfterMs(res.headers, this.opts.now()));
      case "invalid_content":
        return new InvalidContentError(message);
      case "unknown":
        return new UnknownOutcomeError(message);
      case "needs_user":
        return new NeedsUserError(message);
    }
  }

  /** The platform's reading of its error body; a body it can't read gets a generic message. */
  private failure(res: HttpResponse): ApiFailure {
    try {
      return this.opts.failure(res);
    } catch {
      return { message: "the server answered with an error" };
    }
  }
}
