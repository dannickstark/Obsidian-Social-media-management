import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { sendDigest } from "../../src/publish/actions";
import { contentDigest, DIGESTED_VARIANT_FIELDS, IDENTITY_VARIANT_FIELDS } from "../../src/publish/sync";
import { img } from "../platforms/fixtures";

const base: Variant = {
  path: "Social/P.md",
  platform: "wordpress",
  channels: ["wp/blog"],
  mode: "auto",
  status: "scheduled",
  title: "Hello",
  url: "https://example.com",
  media: ["a.png"],
  mediaMeta: { "a.png": { alt: "A", focus: [0.5, 0.5] }, "cover.png": { alt: "Cover" } },
  deliveries: {},
  wordpress: { slug: "hello", categories: ["News"], tags: [], featuredImage: "cover.png" },
};

describe("contentDigest (#66)", () => {
  it("is stable for the same content", () => {
    expect(contentDigest({ ...base }, "Body")).toBe(contentDigest(base, "Body"));
  });

  it.each<[string, Partial<Variant>]>([
    ["platform", { platform: "mastodon" }],
    ["title", { title: "Hello again" }],
    ["url", { url: "https://example.com/2" }],
    ["media", { media: ["b.png"] }],
    ["mediaMeta (image alt)", { mediaMeta: { ...base.mediaMeta, "a.png": { alt: "Another" } } }],
    ["mediaMeta (image focus)", { mediaMeta: { ...base.mediaMeta, "a.png": { alt: "A", focus: [0.1, 0.9] } } }],
    ["mediaMeta (featured alt)", { mediaMeta: { ...base.mediaMeta, "cover.png": { alt: "New cover" } } }],
    ["wordpress", { wordpress: { ...base.wordpress!, slug: "hello-2" } }],
  ])("changes when %s changes", (_field, patch) => {
    expect(contentDigest({ ...base, ...patch }, "Body")).not.toBe(contentDigest(base, "Body"));
  });

  it("changes with the body and ignores who, where and when", () => {
    expect(contentDigest(base, "Body!")).not.toBe(contentDigest(base, "Body"));
    const moved = { ...base, scheduledAt: 5, channels: [], status: "draft" as const, deliveries: { "wp/blog": { status: "draft" as const } }, review: "claude" };
    expect(contentDigest(moved, "Body")).toBe(contentDigest(base, "Body"));
  });
});

describe("variant field classes (M4 carry, #87)", () => {
  it("classify every Variant field exactly once", () => {
    // Required<Variant> makes this fail to compile when a field is added to Variant without classifying it here.
    const every: Required<Variant> = {
      ...base,
      campaignLink: "Event X",
      scheduledAt: 1,
      staggerMinutes: 0,
      reminders: [],
      mediaMeta: {},
      invalidDeliveries: [],
      wordpress: base.wordpress!,
      title: "t",
      url: "u",
      review: "claude",
    };
    const classified = [...DIGESTED_VARIANT_FIELDS, ...IDENTITY_VARIANT_FIELDS];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(every).sort());
  });

  it("every digested field reaches sendDigest (through the resolved media for media and mediaMeta)", () => {
    const content = { body: "Body", media: [img("a.png")], featured: img("cover.png") };
    const patches: Array<Partial<Variant>> = [{ platform: "mastodon" }, { title: "Other" }, { url: "https://example.com/other" }, { wordpress: { ...base.wordpress!, tags: ["x"] } }];
    for (const patch of patches) expect(sendDigest({ ...base, ...patch }, content)).not.toBe(sendDigest(base, content));
    expect(sendDigest(base, { ...content, media: [img("a.png", 1080, 1080, { alt: "Other" })] })).not.toBe(sendDigest(base, content));
    expect(sendDigest(base, { ...content, featured: img("cover.png", 1080, 1080, { alt: "Other" }) })).not.toBe(sendDigest(base, content));
  });
});
