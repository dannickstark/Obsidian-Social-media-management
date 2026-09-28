import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, PublishError, TransientError, classifyError } from "../../src/platforms/errors";

const http = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed, status ${status}`), { status, headers });

describe("classifyError", () => {
  it.each([
    [http(401), "needs_user"],
    [http(403), "needs_user"],
    [http(404), "needs_user"],
    [http(408), "transient"],
    [http(429), "transient"],
    [http(500), "transient"],
    [http(503), "transient"],
    [http(400), "invalid_content"],
    [http(413), "invalid_content"],
    [http(422), "invalid_content"],
    [new Error("net::ERR_TIMED_OUT"), "transient"],
    ["boom", "transient"],
  ])("%s → %s", (error, kind) => {
    expect(classifyError(error).kind).toBe(kind);
  });

  it("keeps errors that are already classified", () => {
    const e = new NeedsUserError("Token expired");
    expect(classifyError(e)).toBe(e);
    expect(new TransientError("slow")).toBeInstanceOf(PublishError);
    expect(new InvalidContentError("too long").kind).toBe("invalid_content");
  });

  it("reads Retry-After in seconds, in any header case", () => {
    expect(classifyError(http(429, { "Retry-After": "30" })).retryAfterMs).toBe(30_000);
    expect(classifyError(http(429, { "retry-after": "soon" })).retryAfterMs).toBeUndefined();
  });

  it("keeps the original message", () => {
    expect(classifyError(http(401)).message).toBe("Request failed, status 401");
  });
});
