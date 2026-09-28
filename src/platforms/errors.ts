/**
 * `unknown` (Ruling P4): the outcome of a send is not known — a network error or timeout raised by
 * `adapter.publish` after the request may already have reached the platform. It is never classified
 * by `classifyError` itself (which keeps its existing, general-purpose behaviour); the orchestrator
 * decides this case for a publish attempt specifically, since only it knows the send just happened.
 */
export type ErrorKind = "transient" | "needs_user" | "invalid_content" | "unknown";

/** Spec §4.1: every adapter error is normalised into one of three classes. */
export class PublishError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export class TransientError extends PublishError {
  constructor(message: string, retryAfterMs?: number) {
    super("transient", message, retryAfterMs);
    this.name = "TransientError";
  }
}

export class NeedsUserError extends PublishError {
  constructor(message: string) {
    super("needs_user", message);
    this.name = "NeedsUserError";
  }
}

export class InvalidContentError extends PublishError {
  constructor(message: string) {
    super("invalid_content", message);
    this.name = "InvalidContentError";
  }
}

/** Ruling P4: a send whose outcome is unknown (see `ErrorKind`). Built by the orchestrator, not `classifyError`. */
export class UnknownOutcomeError extends PublishError {
  constructor(message: string) {
    super("unknown", message);
    this.name = "UnknownOutcomeError";
  }
}

/** Whether the error carries an HTTP status, i.e. classifyError read it off a real response rather than guessing. */
export function statusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null || !("status" in e)) return undefined;
  const status = (e as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function retryAfterMs(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null || !("headers" in e)) return undefined;
  const headers = (e as { headers: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const entry = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === "retry-after");
  const seconds = Number(entry?.[1]);
  return entry && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Normalise anything an adapter throws. HTTP errors come from `requestUrl`, which attaches
 * `status` and `headers`; errors without a status are network failures or timeouts.
 */
export function classifyError(e: unknown): PublishError {
  if (e instanceof PublishError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  if (status === undefined) return new TransientError(message);
  if (status === 401 || status === 403) return new NeedsUserError(message);
  if (status === 408 || status === 429 || status >= 500) return new TransientError(message, retryAfterMs(e));
  if (status === 400 || status === 413 || status === 422) return new InvalidContentError(message);
  return new NeedsUserError(message);
}

/**
 * M5 (#66): the platform's copy of a handed-over post is gone (a Mastodon content update removed the scheduled
 * post and could not schedule the new one; a WordPress post was deleted on the site). The caller returns the
 * delivery to `scheduled`, so the post still goes out from Obsidian.
 */
export class RemoteRemovedError extends PublishError {
  constructor(message: string) {
    super("needs_user", message);
    this.name = "RemoteRemovedError";
  }
}
