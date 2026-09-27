import { describe, expect, it } from "vitest";
import { bodyOf, countChars, excerpt, extractEmbeds, plainText, splitThread } from "../../src/model/body";

describe("bodyOf", () => {
  it("strips frontmatter", () => {
    expect(bodyOf("---\na: 1\n---\nHello\n")).toBe("Hello\n");
    expect(bodyOf("Hello")).toBe("Hello");
  });
});

describe("splitThread", () => {
  it("splits on body-level --- lines", () => {
    expect(splitThread("One\n---\nTwo\n\n---\n\nThree\n")).toEqual(["One", "Two", "Three"]);
  });

  it("ignores --- inside code fences", () => {
    const body = "Intro\n```yaml\n---\nkey: 1\n```\n---\nSecond";
    expect(splitThread(body)).toEqual(["Intro\n```yaml\n---\nkey: 1\n```", "Second"]);
  });

  it("drops empty items and keeps a single post intact", () => {
    expect(splitThread("---\nOnly\n---\n")).toEqual(["Only"]);
    expect(splitThread("Just one post")).toEqual(["Just one post"]);
  });
});

describe("extractEmbeds", () => {
  it("collects wikilink and markdown image embeds in order, deduplicated", () => {
    const body = "![[cover.png]]\ntext ![alt](img/local.jpg) ![[cover.png|300]] ![remote](https://x.com/a.png) ![[b.webp]]";
    expect(extractEmbeds(body)).toEqual(["cover.png", "img/local.jpg", "b.webp"]);
  });
});

describe("plainText and excerpt", () => {
  it("resolves links to readable text", () => {
    expect(plainText("See [[Event X|the event]], [[Notes/Plan]] and [site](https://a.b)\n![[x.png]]")).toBe(
      "See the event, Plan and site\n",
    );
  });

  it("uses the first meaningful line, trimmed to max", () => {
    expect(excerpt("\n# I almost didn't host Event X.\n\nMore")).toBe("I almost didn't host Event X.");
    expect(excerpt("- a list item")).toBe("a list item");
    expect(excerpt("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(excerpt("")).toBe("");
  });
});

describe("countChars", () => {
  it.each([
    ["hello", 5, 5],
    ["日本", 2, 4],
    ["👍🏽", 1, 2],
    ["é", 1, 1],
    ["Visit https://example.com/a/very/long/path now", 46, 33],
  ])("%s → graphemes %i, x-weighted %i", (text, graphemes, weighted) => {
    expect(countChars(text)).toBe(graphemes);
    expect(countChars(text, "x-weighted")).toBe(weighted);
  });
});
