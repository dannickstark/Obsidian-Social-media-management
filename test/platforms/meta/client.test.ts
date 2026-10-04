import { describe, expect, it } from "vitest";
import { NeedsUserError, TransientError } from "../../../src/platforms/errors";
import { MetaClient } from "../../../src/platforms/meta/client";
import { obsidianHttp } from "../../../src/platforms/http";
import { call, json, netError, queue, text } from "../http";

const TOKEN = "user-secret+123456";
const client = () => new MetaClient({ http: obsidianHttp, now: () => 1_000, timeoutMs: 100 });

describe("MetaClient", () => {
  it("sends a supplied token only in the Authorization header", async () => {
    queue(json(200, { id: "123" }));
    expect(await client().get("me", TOKEN, { fields: "id" })).toEqual({ id: "123" });
    expect(call(0).url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/me\?fields=id$/);
    expect(call(0).headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call(0).url).not.toContain(TOKEN);
  });

  it("follows only same-path cursor paging and collects all rows", async () => {
    queue(
      json(200, {
        data: [{ id: "1" }],
        paging: {
          next: "https://graph.facebook.com/v24.0/me/accounts?after=cursor-2&access_token=leaked",
          cursors: { after: "cursor-2" },
        },
      }),
      json(200, { data: [{ id: "2" }] }),
    );
    expect(await client().list("me/accounts", TOKEN, { fields: "id" })).toEqual([
      { id: "1" },
      { id: "2" },
    ]);
    expect(call(1).url).toContain("after=cursor-2");
    expect(call(1).url).not.toContain("access_token");
    expect(call(1).headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a paging URL on another origin", async () => {
    queue(json(200, { data: [], paging: { next: "https://evil.example/steal?after=abc" } }));
    await expect(client().list("me/accounts", TOKEN)).rejects.toBeInstanceOf(NeedsUserError);
  });

  it("stops at the page bound instead of returning a partial list", async () => {
    queue(
      json(200, {
        data: [{ id: "1" }],
        paging: {
          cursors: { after: "next" },
          next: "https://graph.facebook.com/v24.0/me/accounts?after=next",
        },
      }),
    );
    await expect(client().list("me/accounts", TOKEN, {}, 1)).rejects.toMatchObject({
      kind: "needs_user",
    });
  });

  it("turns missing permission and expired token codes into explicit user actions", async () => {
    queue(
      json(400, { error: { code: 200, message: "secret" } }),
      json(400, { error: { code: 190, error_subcode: 463, message: "secret" } }),
    );
    await expect(client().get("me/accounts", TOKEN)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringMatching(/permission/i),
    });
    await expect(client().get("me/accounts", TOKEN)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringMatching(/expired|new token/i),
    });
  });

  it.each([4, 17, 32, 341, 613, 80004])(
    "treats Graph throttle code %i as transient",
    async (code) => {
      queue(
        json(400, { error: { code, message: "request limit reached" } }, { "Retry-After": "5" }),
      );
      await expect(client().get("me/accounts", TOKEN)).rejects.toMatchObject({
        kind: "transient",
        retryAfterMs: 5000,
      });
    },
  );

  it("describes code 2500 as an unknown Graph path rather than missing permission", async () => {
    queue(json(400, { error: { code: 2500, message: "Unknown path components: /me" } }));
    const error: Error = await client()
      .get("me", TOKEN)
      .then(
        () => new Error("request unexpectedly succeeded"),
        (e: unknown) => e as Error,
      );
    expect(error).toBeInstanceOf(NeedsUserError);
    expect(error.message).toMatch(/path|endpoint/i);
    expect(error.message).not.toMatch(/permission/i);
  });

  it("redacts raw and URL-encoded tokens from provider diagnostics", async () => {
    queue(
      json(400, { error: { code: 999, message: `Bad ${TOKEN} or ${encodeURIComponent(TOKEN)}` } }),
    );
    const error: Error = await client()
      .get("me", TOKEN)
      .then(
        () => new Error("request unexpectedly succeeded"),
        (e: unknown) => e as Error,
      );
    expect(error.message).toContain("[secret]");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(encodeURIComponent(TOKEN));
  });

  it("rejects malformed success JSON with a safe explanation", async () => {
    queue(text(200, "<html>not JSON</html>"));
    await expect(client().get("me", TOKEN)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringMatching(/unreadable/i),
    });
  });

  it("classifies connection failures before any publishing as transient", async () => {
    queue(netError);
    await expect(client().get("me", TOKEN)).rejects.toBeInstanceOf(TransientError);
  });
});
