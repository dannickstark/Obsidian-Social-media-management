import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { indexed } from "../helpers";

describe("CampaignTable", () => {
  it("renders variants and creates a missing one with all channels of that platform", async () => {
    const { app, ctx, index } = await makeCtx({ seed: true });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(ctx) });
    expect(screen.getByText(/9 created · 0 published · 1 overdue/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp variant" }));
    await indexed(index, () => index.getVariant("Social/Event X/Event X – WhatsApp.md") !== undefined);
    const created = index.getVariant("Social/Event X/Event X – WhatsApp.md");
    expect(created?.channels).toEqual(["wa/makers-berlin"]);
    expect(app.workspace.opened.at(-1)?.linktext).toBe("Social/Event X/Event X – WhatsApp.md");
  });

  it("offers Review… instead of Post now for a note Claude wrote while Obsidian was closed (#84 fix round 1, I2)", async () => {
    const P = "Social/Event X/Event X – Mastodon.md";
    const { ctx } = await makeCtx({
      seed: true,
      notes: [
        {
          path: P,
          frontmatter: {
            type: "social-post",
            campaign: "[[Event X]]",
            platform: "mastodon",
            channels: ["ma/you"],
            status: "overdue",
            review: "claude",
            scheduled_at: "2026-10-06T18:00:00+02:00",
            deliveries: { "ma/you": { status: "overdue" } },
          },
          body: "Event X is back on the 12th.",
        },
      ],
    });
    const openComposer = vi.spyOn(ctx.composer, "openComposer").mockResolvedValue();
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(ctx) });
    expect(screen.queryByRole("button", { name: "Post Mastodon variant now" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Review Mastodon variant" }));
    expect(openComposer).toHaveBeenCalledWith(P);
  });
});
