import { describe, expect, it } from "vitest";
import type { Platform } from "../../src/model/platforms";
import { validateLiveUrl } from "../../src/publish/liveUrl";

const NOT_A_LINK = "Paste the full link to the post, starting with https://";

describe("validateLiveUrl (review focus 4)", () => {
  it.each([
    ["linkedin", "https://www.linkedin.com/feed/update/urn:li:activity:1", undefined, true],
    ["x", "https://twitter.com/you/status/1", undefined, true],
    ["reddit", "https://old.reddit.com/r/x/comments/1", undefined, true],
    ["hackernews", "https://news.ycombinator.com/item?id=1", undefined, true],
    ["mastodon", "https://mastodon.social/@you/1", "@you@mastodon.social", true],
    ["mastodon", "https://any.instance/@you/1", undefined, true],
    ["wordpress", "https://eventx.berlin/2026/10/back/", "eventx.berlin", true],
  ] as Array<[Platform, string, string | undefined, boolean]>)("%s accepts %s", (platform, url, handle, ok) => {
    expect(validateLiveUrl(platform, `  ${url} `, { handle })).toEqual(ok ? { ok: true, url } : expect.anything());
  });

  it.each([
    ["linkedin", "https://x.com/you/status/1", undefined, "That isn't a LinkedIn link (expected linkedin.com)."],
    ["x", "see my post", undefined, NOT_A_LINK],
    ["bluesky", "http://", undefined, NOT_A_LINK],
    ["bluesky", "https://localhost/post", undefined, NOT_A_LINK],
    ["bluesky", "ftp://bsky.app/x", undefined, NOT_A_LINK],
    ["mastodon", "https://fosstodon.org/@you/1", "@you@mastodon.social", "That isn't a Mastodon link (expected mastodon.social)."],
    ["wordpress", "https://other.blog/post", "eventx.berlin", "That isn't a WordPress link (expected eventx.berlin)."],
  ] as Array<[Platform, string, string | undefined, string]>)("%s refuses %s", (platform, url, handle, reason) => {
    expect(validateLiveUrl(platform, url, { handle })).toEqual({ ok: false, reason });
  });
});
