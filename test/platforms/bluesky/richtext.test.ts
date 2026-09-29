import { describe, expect, it } from "vitest";
import { buildFacets, findLinks, findMentions, findTags, utf8Length } from "../../../src/platforms/bluesky/richtext";

const resolve = async (handle: string) => (handle === "alice.bsky.social" ? "did:plc:alice" : null);

describe("Bluesky facets (byte offsets, review focus 2)", () => {
  it("counts emoji with a skin tone as eight bytes", async () => {
    const text = "Hi 👋🏽 @alice.bsky.social see https://example.com #osmm";
    expect(utf8Length("👋🏽")).toBe(8);
    expect(await buildFacets(text, resolve)).toEqual([
      { index: { byteStart: 12, byteEnd: 30 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }] },
      { index: { byteStart: 35, byteEnd: 54 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
      { index: { byteStart: 55, byteEnd: 60 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "osmm" }] },
    ]);
  });

  it("counts accented letters and CJK by their UTF-8 length", async () => {
    expect(await buildFacets("Café #über", resolve)).toEqual([{ index: { byteStart: 6, byteEnd: 12 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "über" }] }]);
    expect(await buildFacets("東京 https://example.jp", resolve)).toEqual([{ index: { byteStart: 7, byteEnd: 25 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.jp" }] }]);
  });

  it("leaves out a mention whose handle doesn't resolve", async () => {
    expect(await buildFacets("Thanks @nobody.example.com!", resolve)).toEqual([]);
  });

  it("trims punctuation after a link, and ignores mentions and tags inside links", () => {
    expect(findLinks("See https://example.com/a. Or (https://example.com/b)!")).toEqual([
      { start: 4, end: 25, uri: "https://example.com/a" },
      { start: 31, end: 52, uri: "https://example.com/b" },
    ]);
    expect(findMentions("https://example.com/@alice.bsky.social and mail me@alice.example.com")).toEqual([]);
    expect(findTags("https://example.com/#top #1 #2026 #v2")).toEqual([{ start: 34, end: 37, tag: "v2" }]);
  });

  it("finds a mention at the start and after a parenthesis", () => {
    expect(findMentions("@alice.bsky.social (@bob.test)").map((m) => m.handle)).toEqual(["alice.bsky.social", "bob.test"]);
  });
});
