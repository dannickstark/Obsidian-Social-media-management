import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { sendDigest } from "../../src/publish/actions";
import { contentDigest, DIGESTED_VARIANT_FIELDS, handedOverChannels, IDENTITY_VARIANT_FIELDS, outOfSync, syncInfo } from "../../src/publish/sync";
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
    ["mediaMeta (generated source)", { mediaMeta: { ...base.mediaMeta, "a.png": { ...base.mediaMeta!["a.png"], sourcePath: "Attachments/original.png" } } }],
    ["mediaMeta (generated crop path)", { mediaMeta: { ...base.mediaMeta, "a.png": { ...base.mediaMeta!["a.png"], cropPath: "Attachments/crop.png" } } }],
    ["mediaMeta (generated crop ratio)", { mediaMeta: { ...base.mediaMeta, "a.png": { ...base.mediaMeta!["a.png"], cropRatio: 1 } } }],
    ["wordpress", { wordpress: { ...base.wordpress!, slug: "hello-2" } }],
  ])("changes when %s changes", (_field, patch) => {
    expect(contentDigest({ ...base, ...patch }, "Body")).not.toBe(contentDigest(base, "Body"));
  });

  it("changes with the body and ignores who, where and when", () => {
    expect(contentDigest(base, "Body!")).not.toBe(contentDigest(base, "Body"));
    const moved = { ...base, scheduledAt: 5, channels: [], status: "draft" as const, deliveries: { "wp/blog": { status: "draft" as const } }, review: "claude" };
    expect(contentDigest(moved, "Body")).toBe(contentDigest(base, "Body"));
  });

  it("changes when an image embedded in the WordPress body gets new alt text (M5 P8)", () => {
    const body = "Intro\n\n![[inside.png]]";
    const before = { ...base, mediaMeta: { ...base.mediaMeta, "inside.png": { alt: "Before" } } };
    const after = { ...before, mediaMeta: { ...before.mediaMeta, "inside.png": { alt: "After" } } };
    expect(contentDigest(after, body)).not.toBe(contentDigest(before, body));
    const content = { body, media: [], featured: img("cover.png") };
    expect(sendDigest(after, content)).not.toBe(sendDigest(before, content));
  });

  it("does not digest body-image alt text for a platform that does not send WordPress body images", () => {
    const body = "Intro\n\n![[inside.png]]";
    const before = { ...base, platform: "mastodon" as const, wordpress: undefined, mediaMeta: { "inside.png": { alt: "Before" } } };
    const after = { ...before, mediaMeta: { "inside.png": { alt: "After" } } };
    expect(contentDigest(after, body)).toBe(contentDigest(before, body));
    expect(sendDigest(after, { body, media: [] })).toBe(sendDigest(before, { body, media: [] }));
  });

  it("changes for live generated crop and original fingerprints, including a featured image", () => {
    const generated = { ...base, mediaMeta: {
      ...base.mediaMeta,
      "a.png": { sourcePath: "Attachments/original.png", cropPath: "Attachments/a.png", cropRatio: 1, focus: [0.5, 0.5] as [number, number] },
      "cover.png": { sourcePath: "Attachments/hero-original.png", focus: [0.5, 0.5] as [number, number] },
    } };
    const images = [
      { ...img("a.png"), fingerprint: "crop-1", sourceFingerprint: "original-1" },
      { ...img("cover.png"), fingerprint: "hero-1", sourceFingerprint: "hero-original-1" },
    ];
    const before = contentDigest(generated, "Body", images);
    expect(contentDigest(generated, "Body", [{ ...images[0]!, sourceFingerprint: "original-2" }, images[1]!])).not.toBe(before);
    expect(contentDigest(generated, "Body", [images[0]!, { ...images[1]!, fingerprint: "hero-2" }])).not.toBe(before);
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

describe("syncInfo (#66)", () => {
  const v = (d: Record<string, unknown>, digest = "D") => ({ channels: ["ma/you"], deliveries: { "ma/you": { status: "handed_over", remoteId: "1", ...d } }, digest }) as never;

  it("is in sync when the digest and the time match the platform's copy", () => {
    expect(syncInfo(v({ at: 5, remoteAt: 5, digest: "D" }), "ma/you")).toEqual({ channelId: "ma/you", state: "in_sync", content: false, time: false, remoteAt: 5, at: 5 });
  });

  it("is out of sync when the content or the time changed", () => {
    expect(syncInfo(v({ at: 5, remoteAt: 5, digest: "OLD" }), "ma/you")).toMatchObject({ state: "out_of_sync", content: true, time: false });
    expect(syncInfo(v({ at: 9, remoteAt: 5, digest: "D" }), "ma/you")).toMatchObject({ state: "out_of_sync", content: false, time: true });
    expect(outOfSync(v({ at: 9, remoteAt: 5, digest: "D" }))).toBe(true);
  });

  it("can't tell for a hand-over without a baseline, and ignores claims in progress and other statuses", () => {
    expect(syncInfo(v({ at: 5 }), "ma/you")).toMatchObject({ state: "unknown" });
    expect(syncInfo(v({ remoteId: undefined, at: 5, remoteAt: 5, digest: "D" }), "ma/you")).toBeNull();
    expect(syncInfo({ channels: ["ma/you"], deliveries: { "ma/you": { status: "scheduled" } } } as never, "ma/you")).toBeNull();
    expect(handedOverChannels(v({ at: 5, remoteAt: 5, digest: "D" })).map((s) => s.channelId)).toEqual(["ma/you"]);
  });
});
