import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { deliveryJob } from "../../src/publish/job";
import { channel, img } from "../platforms/fixtures";

const variant = (platform: Variant["platform"], extra: Partial<Variant> = {}): Variant => ({
  path: "Social/P.md",
  platform,
  channels: [],
  mode: "auto",
  status: "scheduled",
  media: [],
  deliveries: {},
  ...extra,
});

describe("deliveryJob", () => {
  it("splits a thread and keeps the media of platforms that show media", () => {
    const job = deliveryJob(variant("mastodon"), channel("ma/you"), { status: "publishing", at: 1 }, { body: "One\n---\nTwo", media: [img()] }, "tok");
    expect(job).toMatchObject({ text: "One\n\nTwo", items: ["One", "Two"], media: [img()], secret: "tok", delivery: { status: "publishing", at: 1 } });
    expect(job.featured).toBeUndefined();
  });

  it("drops media on platforms that show none, and carries the featured image", () => {
    expect(deliveryJob(variant("hackernews"), channel("hn/you"), { status: "publishing" }, { body: "Hi", media: [img()] }, null).media).toEqual([]);
    const wp = deliveryJob(variant("wordpress"), channel("wp/blog"), { status: "handed_over" }, { body: "# Title", media: [], featured: img("cover.png") }, null);
    expect(wp.featured).toEqual(img("cover.png"));
  });

  it("carries the raw Markdown body, embeds included, next to the rendered text (M5 P3)", () => {
    const body = "Intro\n\n![[diagram.png]]\n\nMore";
    const job = deliveryJob(variant("wordpress"), channel("wp/blog"), { status: "handed_over" }, { body, media: [] }, null);
    expect(job.body).toBe(body);
    expect(job.text).not.toContain("![[diagram.png]]");
  });
});
