import { describe, expect, it } from "vitest";
import { channelRowStatus } from "../../src/index/queries";
import { parseVariant } from "../../src/model/frontmatter";
import type { Variant } from "../../src/model/types";
import { scheduleDeliveries } from "../../src/planner/board";
import { effectiveDelivery, unreadable } from "../../src/publish/eligibility";
import { makeCtx } from "../ui/ctx";

const base = { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme", "li/maker"], status: "scheduled", scheduled_at: "2026-10-12T09:00:00+02:00" };
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "scheduled",
  scheduledAt: 1,
  media: [],
  deliveries: {},
  ...extra,
});

describe("unreadable delivery entries", () => {
  it("are listed by the parser", () => {
    const r = parseVariant({ ...base, deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "Handed-Over" }, "li/maker": "oops" } }, "p.md");
    expect(r.value?.invalidDeliveries).toEqual(["li/acme", "li/maker"]);
    expect(r.value?.deliveries).toEqual({ "li/me": { status: "scheduled" } });
    expect(parseVariant({ ...base, deliveries: { "li/me": { status: "scheduled" } } }, "p.md").value?.invalidDeliveries).toBeUndefined();
  });

  it("are never scheduled over by the board", () => {
    const post = v({ status: "draft", invalidDeliveries: ["li/acme"] });
    expect(scheduleDeliveries(post)).toEqual({ "li/me": { status: "scheduled" } });
  });

  it("have no effective delivery", () => {
    expect(unreadable(v({ invalidDeliveries: ["li/acme"] }), "li/acme")).toBe(true);
    expect(effectiveDelivery(v({ invalidDeliveries: ["li/acme"] }), "li/acme")).toBeNull();
  });
});

describe("effectiveDelivery", () => {
  it.each([
    ["its own record", v({ deliveries: { "li/me": { status: "awaiting_you", at: 5 } } }), "li/me", { status: "awaiting_you", at: 5 }],
    ["the inherited status when siblings have records", v({ deliveries: { "li/me": { status: "published" } } }), "li/acme", { status: "scheduled" }],
    ["the stored status without records", v({ status: "published" }), "li/me", { status: "published" }],
    ["attention without records reads as failed", v({ status: "attention" }), "li/me", { status: "failed" }],
    ["nothing for an idea", v({ status: "idea" }), "li/me", null],
    ["nothing for a channel that is not listed", v(), "li/other", null],
  ])("%s", (_name, post, id, expected) => {
    expect(effectiveDelivery(post, id)).toEqual(expected);
  });

  it("matches the row statuses of the index", async () => {
    const { ctx } = await makeCtx({ seed: true });
    for (const row of ctx.actions.rows().filter((r) => r.channelId)) {
      expect(channelRowStatus(row.variant, row.channelId!)).toBe(row.status);
    }
  });
});

describe("checks", () => {
  it("block a post with an unreadable entry", async () => {
    const path = "Social/Posts/Typo.md";
    const { ctx, index } = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { ...base, channels: ["li/me", "li/acme-studio"], deliveries: { "li/acme-studio": { status: "Handed-Over" } } }, body: "Hi" }],
    });
    const post = index.getVariant(path)!;
    const issues = ctx.composer.check(post, await ctx.composer.content.load(post));
    expect(issues).toContainEqual({
      level: "error",
      field: "deliveries.li/acme-studio",
      code: "unreadable-delivery",
      message: "Fix the delivery status of Acme Studio in the note: it can't be read, so it won't be published.",
    });
  });
});
