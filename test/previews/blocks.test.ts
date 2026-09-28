import { describe, expect, it } from "vitest";
import { articleBlocks } from "../../src/previews/model";

describe("articleBlocks", () => {
  it("parses headings, paragraphs, lists, quotes, rules and images", () => {
    const md = "# Title\n\nIntro with **bold** and [[Event X]].\nSecond line\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n![[cover.png]]\n%%hidden%%\n";
    expect(articleBlocks(md)).toEqual([
      { kind: "heading", level: 1, segments: [{ text: "Title" }] },
      { kind: "paragraph", segments: [{ text: "Intro with " }, { text: "bold", bold: true }, { text: " and Event X.\nSecond line" }] },
      { kind: "list", ordered: false, items: [[{ text: "one" }], [{ text: "two" }]] },
      { kind: "list", ordered: true, items: [[{ text: "first" }]] },
      { kind: "quote", segments: [{ text: "quote" }] },
      { kind: "rule" },
      { kind: "image", target: "cover.png" },
    ]);
  });

  it("drops a leading H1 that repeats the title", () => {
    expect(articleBlocks("# We're back\n\nHello", "We're back")).toEqual([{ kind: "paragraph", segments: [{ text: "Hello" }] }]);
    expect(articleBlocks("# Another\n\nHello", "We're back")[0]).toMatchObject({ kind: "heading" });
  });

  it("pulls an inline embed out of paragraph text into an image block right after it", () => {
    const blocks = articleBlocks("Some text ![[cover.png]] more text");
    expect(blocks).toEqual([
      { kind: "paragraph", segments: [{ text: "Some text more text" }] },
      { kind: "image", target: "cover.png" },
    ]);
    for (const b of blocks) {
      if (b.kind === "paragraph") {
        for (const s of b.segments) {
          expect(s.text).not.toContain("![[");
          expect(s.text).not.toContain("](");
        }
      }
    }
  });
});
