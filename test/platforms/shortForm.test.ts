import { describe, expect, it } from "vitest";
import { countChars } from "../../src/model/body";
import { blocking, counters, validateAll, validateFor } from "../../src/platforms/checks";
import { platformDef } from "../../src/platforms/registry";
import { channel, img, input, messages } from "./fixtures";

const X = platformDef("x");
const BS = platformDef("bluesky");
const MA = platformDef("mastodon");
const IG = platformDef("instagram");

describe("X (280 weighted, URL = 23, media ≤ 4)", () => {
  it.each([
    ["280 Latin characters", "a".repeat(280), []],
    ["281 Latin characters", "a".repeat(281), ["error:body:The text is 281/280 characters."]],
    ["140 CJK characters (weight 2)", "界".repeat(140), []],
    ["141 CJK characters", "界".repeat(141), ["error:body:The text is 282/280 characters."]],
    ["140 emoji (weight 2)", "🎉".repeat(140), []],
    ["a long URL counts 23", `${"a".repeat(256)} https://example.com/${"x".repeat(200)}`, []],
    ["an empty post", "", ["error:body:Write the post text first."]],
  ])("%s", (_name, body, expected) => {
    expect(messages(validateFor(input("x", body), X))).toEqual(expected);
  });

  it("validates each thread item", () => {
    expect(messages(validateFor(input("x", `short\n---\n${"b".repeat(281)}`), X))).toEqual(["error:body.2:Part 2 is 281/280 characters."]);
  });

  it("counts the url the adapter appends to the first part (Task 6 follow-up)", () => {
    const url = "https://example.com/x"; // a URL counts 23, plus the blank line: 25
    expect(messages(validateFor(input("mastodon", "a".repeat(476), { url }), MA))).toEqual(["error:body:The text is 501/500 characters."]);
    expect(messages(validateFor(input("mastodon", `${"a".repeat(476)}\n---\nHi`, { url }), MA))).toEqual(["error:body.1:Part 1 is 501/500 characters."]);
    expect(validateFor(input("mastodon", `Hi\n---\n${"a".repeat(500)}`, { url }), MA)).toEqual([]);
  });

  it.each([
    ["period after URL", "https://example.com.", 24],
    ["comma after URL", "https://example.com,", 24],
    ["exclamation after URL", "https://example.com!", 24],
    ["balanced closing parenthesis", "(https://example.com/a_(b)).", 26],
  ])("keeps punctuation outside the shortened URL (%s)", (_name, text, expected) => {
    expect(countChars(text, "x-weighted")).toBe(expected);
  });

  it("allows at most four images", () => {
    const media = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((t) => img(t));
    expect(messages(validateFor(input("x", "Hi", {}, media), X))).toEqual(["error:media:X allows at most 4 images; this post has 5."]);
    expect(validateFor(input("x", "Hi", {}, media.slice(0, 4)), X)).toEqual([]);
  });
});

describe("Bluesky (300 graphemes, images ≤ 4, link card)", () => {
  it.each([
    ["300 family emoji (one grapheme each)", "👨‍👩‍👧".repeat(300), []],
    ["301 characters", "a".repeat(301), ["error:body:The text is 301/300 characters."]],
  ])("%s", (_name, body, expected) => {
    expect(messages(validateFor(input("bluesky", body), BS))).toEqual(expected);
  });

  it("warns that a link card and images don't go together", () => {
    const warning = "warning:media:Bluesky shows either images or a link card, not both. The link card will be left out.";
    expect(messages(validateFor(input("bluesky", "Hi", { url: "https://example.com" }, [img()]), BS))).toEqual([warning]);
    expect(messages(validateFor(input("bluesky", "See https://example.com", {}, [img()]), BS))).toEqual([warning]);
    expect(validateFor(input("bluesky", "See https://example.com"), BS)).toEqual([]);
  });
});

describe("Instagram Business images", () => {
  it("requires images, preserves the ten-image carousel limit, and enforces its aspect ratio", () => {
    expect(messages(validateFor(input("instagram", "Caption"), IG))).toContain(
      "error:media:Instagram needs an image.",
    );
    expect(validateFor(input("instagram", "Caption", {}, [img("portrait.png", 1080, 1350)]), IG)).toEqual([]);
    expect(messages(validateFor(input("instagram", "Caption", {}, [img("too-tall.png", 1080, 1920)]), IG))).toContain(
      "error:media.too-tall.png:too-tall.png is 0.56:1; Instagram accepts 0.80:1 to 1.91:1.",
    );
    expect(messages(validateFor(input("instagram", "Caption", {}, Array.from({ length: 11 }, (_, i) => img(`${i}.png`))), IG))).toContain(
      "error:media:Instagram allows at most 10 images; this post has 11.",
    );
  });
});

describe("Mastodon (500 by default, per-channel limit, URL = 23)", () => {
  it("counts every URL as 23 characters", () => {
    const body = `${"a".repeat(470)} https://example.com/${"b".repeat(200)}`;
    expect(countChars(body, "mastodon")).toBe(494);
    expect(validateFor(input("mastodon", body), MA)).toEqual([]);
  });

  it("uses the instance limit of the channel", () => {
    expect(messages(validateFor(input("mastodon", "a".repeat(501)), MA))).toEqual(["error:body:The text is 501/500 characters."]);
    expect(validateFor(input("mastodon", "a".repeat(700)), MA, channel("ma/you", { maxChars: 1000 }))).toEqual([]);
  });

  it("counts the url the adapter appends to the first part (Task 6 follow-up)", () => {
    const url = "https://example.com/x"; // a URL counts 23, plus the blank line: 25
    expect(messages(validateFor(input("mastodon", "a".repeat(476), { url }), MA))).toEqual(["error:body:The text is 501/500 characters."]);
    expect(messages(validateFor(input("mastodon", `${"a".repeat(476)}\n---\nHi`, { url }), MA))).toEqual(["error:body.1:Part 1 is 501/500 characters."]);
    expect(validateFor(input("mastodon", `Hi\n---\n${"a".repeat(500)}`, { url }), MA)).toEqual([]);
  });

  it("allows at most four images", () => {
    const media = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((t) => img(t));
    expect(messages(validateFor(input("mastodon", "Hi", {}, media), MA))).toEqual(["error:media:Mastodon allows at most 4 images; this post has 5."]);
  });
});

describe("validateAll, blocking and counters", () => {
  it("runs per selected channel and reports each issue once", () => {
    const issues = validateAll(input("x", "a".repeat(281)), [channel("x/you"), channel("x/brand")]);
    expect(messages(issues)).toEqual(["error:body:The text is 281/280 characters."]);
    expect(blocking(issues)).toBe(true);
  });

  it("puts blocking issues first", () => {
    const issues = validateAll(input("bluesky", "a".repeat(301), { url: "https://example.com" }, [img()]), []);
    expect(issues.map((i) => i.level)).toEqual(["error", "warning"]);
  });

  it("reports the strictest limit when channels differ", () => {
    const issues = validateAll(input("mastodon", "a".repeat(700)), [channel("ma/big", { maxChars: 1000 }), channel("ma/you")]);
    expect(messages(issues)).toEqual(["error:body:The text is 700/500 characters."]);
  });

  it("counts per thread item", () => {
    expect(counters(input("x", "Hello\n---\nWorld!"), X)).toEqual([
      { label: "Part 1", value: 5, limit: 280 },
      { label: "Part 2", value: 6, limit: 280 },
    ]);
    expect(counters(input("mastodon", "Hi"), MA, channel("ma/you", { maxChars: 1000 }))).toEqual([{ label: "Length", value: 2, limit: 1000 }]);
  });
});
