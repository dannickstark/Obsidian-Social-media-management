import { describe, expect, it } from "vitest";
import type { Variant } from "../../src/model/types";
import { planTemplateMove, templateMovable } from "../../src/planner/templates";

const T = 1_000_000;
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme"],
  mode: "auto",
  status: "overdue",
  scheduledAt: T,
  media: [],
  deliveries: {},
  ...extra,
});

describe("planTemplateMove (parked M1 item)", () => {
  it("turns overdue deliveries back into scheduled ones and moves explicit times", () => {
    const post = v({ deliveries: { "li/me": { status: "overdue" }, "li/acme": { status: "scheduled", at: T + 900 } } });
    expect(planTemplateMove(post, T + 5000)).toEqual({
      fields: { scheduledAt: T + 5000 },
      deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "scheduled", at: T + 5900 } },
    });
  });

  it("drops explicit times when the post had no time yet", () => {
    const post = v({ scheduledAt: undefined, status: "draft", deliveries: { "li/acme": { status: "draft", at: T } } });
    expect(planTemplateMove(post, T + 5000)).toEqual({ fields: { scheduledAt: T + 5000 }, deliveries: { "li/acme": { status: "draft" } } });
  });

  it("never moves a post that is being published or needs a check", () => {
    expect(templateMovable(v({ deliveries: { "li/me": { status: "publishing" } } }))).toBe(false);
    expect(planTemplateMove(v({ deliveries: { "li/me": { status: "check_needed" } } }), T)).toEqual({ refuse: "locked" });
    expect(templateMovable(v())).toBe(true);
  });
});
