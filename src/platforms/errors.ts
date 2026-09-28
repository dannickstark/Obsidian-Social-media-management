export type ErrorKind = "transient" | "needs_user" | "invalid_content";

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

function statusOf(e: unknown): number | undefined {
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
