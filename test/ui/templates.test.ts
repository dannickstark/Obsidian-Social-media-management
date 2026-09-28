import { describe, expect, it } from "vitest";
import { makeCtx } from "./ctx";
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
});
