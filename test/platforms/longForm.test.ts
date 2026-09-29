import { describe, expect, it } from "vitest";
import { blocking, counters, validateFor } from "../../src/platforms/checks";
import { platformDef } from "../../src/platforms/registry";
import type { WordPressFields } from "../../src/model/types";
import { MB } from "../../src/platforms/types";
import { channel, img, input, messages } from "./fixtures";

const check = (...args: Parameters<typeof input>) => messages(validateFor(input(...args), platformDef(args[0])));

describe("LinkedIn", () => {
  it.each([
    ["3 000 characters", "a".repeat(3000), []],
    ["3 001 characters", "a".repeat(3001), ["error:body:The text is 3,001/3,000 characters."]],
    [
      "a link in the text (advisory)",
      "Join us https://example.com/event",
      ["warning:body:Posts with a link in the text often reach fewer people on LinkedIn. Consider moving the link to the first comment."],
    ],
  ])("%s", (_name, body, expected) => {
    expect(check("linkedin", body)).toEqual(expected);
  });

  it("shows where the text folds", () => {
    expect(counters(input("linkedin", "a".repeat(250)), platformDef("linkedin"))).toEqual([
      { label: "Length", value: 250, limit: 3000 },
      { label: "Fold", value: 250, limit: 210 },
    ]);
  });
});

describe("Instagram", () => {
  it("needs an image", () => {
    expect(check("instagram", "Hi")).toEqual(["error:media:Instagram needs an image."]);
  });

  it("accepts 4:5 to 1.91:1 images", () => {
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 1350)])).toEqual([]);
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 566)])).toEqual([]);
    expect(check("instagram", "Hi", {}, [img("a.png", 1080, 1920)])).toEqual(["error:media.a.png:a.png is 0.56:1; Instagram accepts 0.80:1 to 1.91:1."]);
  });

  it("limits hashtags and the caption, and ignores url", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(check("instagram", tags, {}, [img()])).toEqual(["error:body:Instagram allows at most 30 hashtags; this post has 31."]);
    expect(check("instagram", "a".repeat(2201), {}, [img()])).toEqual(["error:body:The text is 2,201/2,200 characters."]);
    expect(check("instagram", "Hi", { url: "https://example.com" }, [img()])).toEqual([
      "warning:url:Instagram doesn't use the url field; put the link in the text if you need it.",
    ]);
  });

  it("counts hashtags", () => {
    expect(counters(input("instagram", "Hi #a #b", {}, [img()]), platformDef("instagram"))).toContainEqual({ label: "Hashtags", value: 2, limit: 30 });
  });
});

describe("chat platforms", () => {
  it("Telegram: 4 096 characters, 1 024 with media", () => {
    expect(check("telegram", "a".repeat(4096))).toEqual([]);
    // M5 P14: a warning, not an error; the adapter sends the photos first and the text as its own message (#88).
    expect(check("telegram", "a".repeat(1024), {}, [img()])).toEqual([]);
    expect(check("telegram", "a".repeat(1025), {}, [img()])).toEqual([
      "warning:body:With media, Telegram allows 1,024 characters in a caption; the photos go first and the text follows as its own message.",
    ]);
  });

  it("Discord: 2 000 characters", () => {
    expect(check("discord", "a".repeat(2001))).toEqual(["error:body:The text is 2,001/2,000 characters."]);
  });

  it("counts the url the adapter appends on its own line (Task 6 follow-up)", () => {
    const url = "https://event.example/x"; // 23 characters, plus the blank line: 25
    expect(check("discord", "a".repeat(1980))).toEqual([]);
    expect(check("discord", "a".repeat(1980), { url })).toEqual(["error:body:The text is 2,005/2,000 characters."]);
    // A text that already has the link is sent as it is.
    expect(check("discord", `${"a".repeat(1970)} ${url}`, { url })).toEqual([]);
    expect(counters(input("discord", "Hi", { url }), platformDef("discord"))).toEqual([{ label: "Length", value: 27, limit: 2000 }]);
    expect(check("telegram", "a".repeat(4080), { url })).toEqual(["error:body:The text is 4,105/4,096 characters."]);
    // Link platforms that don't append it keep counting the text alone.
    expect(check("linkedin", "a".repeat(3000), { url })).toEqual([]);
  });

  it("Telegram's caption warning counts the appended url too, and stays a warning (M5 P14)", () => {
    const url = "https://event.example/x";
    expect(check("telegram", "a".repeat(999), { url }, [img()])).toEqual([]);
    expect(check("telegram", "a".repeat(1000), { url }, [img()])).toEqual([
      "warning:body:With media, Telegram allows 1,024 characters in a caption; the photos go first and the text follows as its own message.",
    ]);
  });

  it("Discord: warns when an alt text is over 1 024 characters, counted by code points (Task 6 follow-up)", () => {
    expect(check("discord", "Hi", {}, [img("cover.png", 1080, 1080, { alt: "\u{1F600}".repeat(1024) })])).toEqual([]);
    expect(check("discord", "Hi", {}, [img("cover.png", 1080, 1080, { alt: "a".repeat(1025) })])).toEqual([
      "warning:media.cover.png:cover.png: Discord shows at most 1,024 characters of alt text; the rest is cut.",
    ]);
  });

  it("WhatsApp: a normal message passes", () => {
    expect(check("whatsapp", "*Event X* at 18:00")).toEqual([]);
  });
});

describe("link platforms", () => {
  it("Hacker News: title ≤ 80 and a url or text", () => {
    expect(check("hackernews", "")).toEqual(["error:title:Hacker News needs a title.", "error:url:Hacker News needs a link (url) or text."]);
    expect(check("hackernews", "", { title: "a".repeat(81), url: "https://example.com" })).toEqual(["error:title:The title is 81/80 characters."]);
    expect(check("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" })).toEqual([]);
    expect(check("hackernews", "Ask away", { title: "Ask HN: planning posts?" })).toEqual([]);
    expect(check("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" }, [img()])).toEqual([
      "warning:media:Hacker News doesn't show attached images; they won't be posted.",
    ]);
  });

  it("Reddit: title ≤ 300 and a subreddit on the channel", () => {
    const reddit = platformDef("reddit");
    const ok = input("reddit", "", { title: "Hello", url: "https://example.com" });
    expect(messages(validateFor(ok, reddit, channel("rd/side", { name: "Side projects", handle: "r/SideProject" })))).toEqual([]);
    expect(messages(validateFor(ok, reddit, channel("rd/side", { name: "Side projects" })))).toEqual([
      "error:channels:Set the subreddit (e.g. r/SideProject) as the handle of Side projects.",
    ]);
    expect(check("reddit", "", { title: "a".repeat(301), url: "https://example.com" })).toEqual(["error:title:The title is 301/300 characters."]);
  });

  it("Indie Hackers: needs a title", () => {
    expect(check("indiehackers", "Building in public.")).toEqual(["error:title:Indie Hackers needs a title."]);
  });
});

describe("WordPress", () => {
  const wp = (extra: Partial<WordPressFields>): WordPressFields => ({ categories: [], tags: [], ...extra });

  it("needs a title and a slug, and suggests a featured image", () => {
    expect(check("wordpress", "Article body")).toEqual([
      "error:title:WordPress needs a title.",
      "error:slug:WordPress needs a slug.",
      "warning:featured_image:No featured image set.",
    ]);
  });

  it("checks the slug format", () => {
    expect(check("wordpress", "Body", { title: "We're back", wordpress: wp({ slug: "Bad Slug", featuredImage: "c.png" }) })).toEqual([
      "error:slug:Use lowercase letters, digits and dashes in the slug.",
    ]);
    expect(check("wordpress", "Body", { title: "We're back", wordpress: wp({ slug: "we-re-back", featuredImage: "c.png" }) })).toEqual([]);
  });
});

describe("media problems (review focus 2)", () => {
  it("flags missing files, videos, other files, oversized images and missing alt text", () => {
    const media = [
      { target: "gone.png", kind: "missing" as const },
      { target: "clip.mp4", kind: "video" as const, path: "clip.mp4" },
      { target: "doc.pdf", kind: "unsupported" as const, path: "doc.pdf" },
      img("big.png", 1000, 1000, { bytes: 9 * MB, alt: "" }),
    ];
    expect(check("linkedin", "Hi", {}, media)).toEqual([
      "error:media.gone.png:gone.png was not found in the vault.",
      "error:media.clip.mp4:clip.mp4: video isn't supported yet. Remove it or use an image.",
      "error:media.doc.pdf:doc.pdf: use a PNG, JPG, WebP or GIF image.",
      "error:media.big.png:big.png is 9.0 MB; LinkedIn accepts up to 8.0 MB.",
      "warning:media.big.png:big.png has no alt text.",
    ]);
  });

  it("tells blocking from advisory issues", () => {
    expect(blocking(validateFor(input("linkedin", "Hi", {}, [img("a.png", 10, 10, { alt: "" })]), platformDef("linkedin")))).toBe(false);
    expect(blocking(validateFor(input("instagram", "Hi"), platformDef("instagram")))).toBe(true);
  });
});
