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

  it("keeps a URL's own matching parenthesis but drops an unmatched wrapping one", async () => {
    const text = "See (https://en.wikipedia.org/wiki/Term_(disambiguation)) for details";
    const uri = "https://en.wikipedia.org/wiki/Term_(disambiguation)";
    const start = text.indexOf(uri);
    const end = start + uri.length;
    const enc = new TextEncoder();
    const byteStart = enc.encode(text.slice(0, start)).length;
    const byteEnd = enc.encode(text.slice(0, end)).length;
    expect(findLinks(text)).toEqual([{ start, end, uri }]);
    expect(await buildFacets(text, resolve)).toEqual([{ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri }] }]);
  });

  it("drops an unmatched closing bracket and a trailing comma", () => {
    const text = "https://x.example/a),";
    const uri = "https://x.example/a";
    expect(findLinks(text)).toEqual([{ start: 0, end: uri.length, uri }]);
  });

  it("computes byte offsets after a ZWJ family emoji and a flag emoji, before a tag and a link", async () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 👨‍👩‍👧‍👦
    const flag = "\u{1F1E9}\u{1F1EA}"; // 🇩🇪
    const text = `${family} ${flag} #home https://example.com`;
    const enc = new TextEncoder();
    const tagIdx = text.indexOf("#home");
    const tagEnd = tagIdx + "#home".length;
    const linkIdx = text.indexOf("https://example.com");
    const linkEnd = linkIdx + "https://example.com".length;
    expect(await buildFacets(text, resolve)).toEqual([
      {
        index: { byteStart: enc.encode(text.slice(0, tagIdx)).length, byteEnd: enc.encode(text.slice(0, tagEnd)).length },
        features: [{ $type: "app.bsky.richtext.facet#tag", tag: "home" }],
      },
      {
        index: { byteStart: enc.encode(text.slice(0, linkIdx)).length, byteEnd: enc.encode(text.slice(0, linkEnd)).length },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
      },
    ]);
  });

  it("computes byte offsets in RTL Arabic text with a mention, a tag and a link", async () => {
    const text = "مرحبا @alice.bsky.social بالعالم #مرحبا https://example.com";
    const enc = new TextEncoder();
    const mentionIdx = text.indexOf("@alice.bsky.social");
    const mentionEnd = mentionIdx + "@alice.bsky.social".length;
    const tagIdx = text.indexOf("#مرحبا");
    const tagEnd = tagIdx + "#مرحبا".length;
    const linkIdx = text.indexOf("https://example.com");
    const linkEnd = linkIdx + "https://example.com".length;
    expect(await buildFacets(text, resolve)).toEqual([
      {
        index: { byteStart: enc.encode(text.slice(0, mentionIdx)).length, byteEnd: enc.encode(text.slice(0, mentionEnd)).length },
        features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }],
      },
      {
        index: { byteStart: enc.encode(text.slice(0, tagIdx)).length, byteEnd: enc.encode(text.slice(0, tagEnd)).length },
        features: [{ $type: "app.bsky.richtext.facet#tag", tag: "مرحبا" }],
      },
      {
        index: { byteStart: enc.encode(text.slice(0, linkIdx)).length, byteEnd: enc.encode(text.slice(0, linkEnd)).length },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
      },
    ]);
  });

  it("gives no facet for a bare @alice with no domain", async () => {
    expect(findMentions("Thanks @alice for the help")).toEqual([]);
    expect(await buildFacets("Thanks @alice for the help", resolve)).toEqual([]);
  });

  it("gives no facet for a lone trailing #", () => {
    expect(findTags("Wait for it #")).toEqual([]);
  });
});
