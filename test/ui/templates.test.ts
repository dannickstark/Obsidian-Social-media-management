import { describe, expect, it } from "vitest";
import { makeCtx } from "./ctx";
import { AWAITING_MOVE } from "../../src/ui/actions";
import { indexed } from "../helpers";
import { planTemplate, DEFAULT_TEMPLATES } from "../../src/planner/templates";
import { Notice } from "../fakes/obsidian";

describe("applyTemplate", () => {
  it("writes proposed times and can undo them", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const campaign = index.getCampaign("Social/Event X/Event X.md")!;
    const proposals = planTemplate(DEFAULT_TEMPLATES[0]!, campaign.anchorDate!, index.variantsOf(campaign.path));
    expect(proposals.length).toBeGreaterThan(0);
    await ctx.actions.applyTemplate(proposals);
    await indexed(index, () => proposals.every((p) => index.getVariant(p.variant.path)?.scheduledAt === p.to));
    for (const p of proposals) expect(index.getVariant(p.variant.path)?.scheduledAt).toBe(p.to);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => proposals.every((p) => index.getVariant(p.variant.path)?.scheduledAt === p.from));
    for (const p of proposals) expect(index.getVariant(p.variant.path)?.scheduledAt).toBe(p.from);
  });

  const awaiting = {
    path: "Social/Posts/Waiting.md",
    frontmatter: {
      type: "social-post",
      platform: "linkedin",
      channels: ["li/me"],
      status: "scheduled",
      scheduled_at: "2026-10-09T09:00:00+02:00",
      deliveries: { "li/me": { status: "awaiting_you" } },
    },
  };

  it("asks before moving an awaiting-you delivery and leaves it when declined (ruling P2)", async () => {
    const { ctx, index } = await makeCtx({ notes: [awaiting] });
    const asked: string[] = [];
    ctx.actions.confirm = async (message) => {
      asked.push(message);
      return false;
    };
    const variant = index.getVariant(awaiting.path)!;
    await ctx.actions.applyTemplate([{ variant, from: variant.scheduledAt, to: variant.scheduledAt! + 86_400_000, label: "T0" }]);
    expect(asked).toEqual([AWAITING_MOVE]);
    expect(index.getVariant(awaiting.path)!.scheduledAt).toBe(variant.scheduledAt);
    expect(Notice.messages.at(-1)).toContain("Skipped 1");
  });

  it("moves an awaiting-you delivery once confirmed and keeps it waiting (ruling P2)", async () => {
    const { ctx, index } = await makeCtx({ notes: [awaiting] });
    ctx.actions.confirm = async () => true;
    const variant = index.getVariant(awaiting.path)!;
    const to = variant.scheduledAt! + 86_400_000;
    await ctx.actions.applyTemplate([{ variant, from: variant.scheduledAt, to, label: "T0" }]);
    await indexed(index, () => index.getVariant(awaiting.path)!.scheduledAt === to);
    expect(index.getVariant(awaiting.path)!.deliveries["li/me"]?.status).toBe("awaiting_you");
  });
});
