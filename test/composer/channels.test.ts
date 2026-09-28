import { describe, expect, it } from "vitest";
import { planSelectGroup, planToggleChannel } from "../../src/composer/channels";
import type { Variant } from "../../src/model/types";

const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "draft",
  media: [],
  deliveries: {},
  ...extra,
});
const ch = (id: string, name = id, platform: Variant["platform"] = "linkedin") => ({ id, name, platform });

describe("planToggleChannel", () => {
  it("adds a channel; with delivery records it gets the post's status", () => {
    expect(planToggleChannel(v(), ch("li/osmm"), true)).toEqual({ fields: { channels: ["li/me", "li/acme", "li/osmm"] } });
    const scheduled = v({ status: "scheduled", scheduledAt: 1, deliveries: { "li/me": { status: "scheduled" } } });
    expect(planToggleChannel(scheduled, ch("li/osmm"), true)).toEqual({
      fields: { channels: ["li/me", "li/acme", "li/osmm"] },
      deliveries: { "li/osmm": { status: "scheduled" } },
    });
  });

  it("refuses a channel of another platform", () => {
    expect(planToggleChannel(v(), ch("x/you", "@you", "x"), true)).toEqual({ refuse: "@you is not a LinkedIn channel." });
  });

  it("removes a channel and only its delivery key", () => {
    const post = v({ deliveries: { "li/me": { status: "draft" }, "li/acme": { status: "draft" } } });
    expect(planToggleChannel(post, ch("li/acme"), false)).toEqual({ fields: { channels: ["li/me"] }, deliveries: { "li/acme": null } });
  });

  it.each([
    ["published", "Me was already published, so it stays on this post."],
    ["publishing", "Me is being published right now, so it stays on this post."],
    ["handed_over", "Me was handed over to the platform, so it stays on this post."],
    ["check_needed", "Me needs a check after an interrupted publish, so it stays on this post."],
    ["awaiting_you", "Me is awaiting you to post manually, so it stays on this post."],
  ] as const)("refuses to remove a %s channel (review focus 4)", (status, reason) => {
    expect(planToggleChannel(v({ deliveries: { "li/me": { status } } }), ch("li/me", "Me"), false)).toEqual({ refuse: reason });
  });

  it("refuses to remove a channel with an unreadable delivery entry (M2b ruling P1)", () => {
    const post = v({ invalidDeliveries: ["li/acme"] });
    expect(planToggleChannel(post, ch("li/acme", "Acme"), false)).toEqual({
      refuse: "Acme's delivery status can't be read from the note, so it stays on this post until you fix it.",
    });
  });

  it("never writes over an unreadable delivery entry when re-adding the channel (M2b ruling P1)", () => {
    const post = v({
      channels: ["li/me"],
      status: "scheduled",
      scheduledAt: 1,
      deliveries: { "li/me": { status: "scheduled" } },
      invalidDeliveries: ["li/acme"],
    });
    expect(planToggleChannel(post, ch("li/acme", "Acme"), true)).toEqual({ fields: { channels: ["li/me", "li/acme"] } });
  });

  it("refuses to remove a channel of a post stored as published without records", () => {
    expect(planToggleChannel(v({ status: "published" }), ch("li/me", "Me"), false)).toEqual({ refuse: "Me was already published, so it stays on this post." });
  });

  it("refuses to remove the last channel of a scheduled post", () => {
    const post = v({ channels: ["li/me"], status: "scheduled", scheduledAt: 1 });
    expect(planToggleChannel(post, ch("li/me", "Me"), false)).toEqual({ refuse: "A scheduled post needs at least one channel. Unschedule it first." });
  });

  it("does nothing when the channel is already in the wanted state", () => {
    expect(planToggleChannel(v(), ch("li/me"), true)).toEqual({});
    expect(planToggleChannel(v(), ch("li/osmm"), false)).toEqual({});
  });
});

describe("planSelectGroup", () => {
  it("adds the group's missing channels of this platform only", () => {
    const group = [ch("li/acme"), ch("li/osmm"), ch("x/you", "@you", "x"), ch("li/maker")];
    expect(planSelectGroup(v(), group)).toEqual({ fields: { channels: ["li/me", "li/acme", "li/osmm", "li/maker"] } });
    expect(planSelectGroup(v({ channels: ["li/acme", "li/osmm", "li/maker"] }), group)).toEqual({});
  });

  it("never writes over an unreadable delivery entry among the added channels (M2b ruling P1)", () => {
    const post = v({
      channels: ["li/me"],
      status: "scheduled",
      scheduledAt: 1,
      deliveries: { "li/me": { status: "scheduled" } },
      invalidDeliveries: ["li/osmm"],
    });
    const group = [ch("li/osmm"), ch("li/maker")];
    expect(planSelectGroup(post, group)).toEqual({
      fields: { channels: ["li/me", "li/osmm", "li/maker"] },
      deliveries: { "li/maker": { status: "scheduled" } },
    });
  });
});
