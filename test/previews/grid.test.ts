import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { Notice } from "../fakes/obsidian";
import PreviewGrid from "../../src/previews/PreviewGrid.svelte";
import { PreviewGridView } from "../../src/previews/PreviewGridView";
import { VIEW_PREVIEW_GRID } from "../../src/ui/actions";
import { osmmContext } from "../../src/ui/context";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const CAMPAIGN = "Social/Event X/Event X.md";
const ready = (name: string, platform: string, channel: string, body: string, when = "2026-10-20T09:00:00+02:00") => ({
  path: `Social/Event X/Event X – ${name}.md`,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform, channels: [channel], status: "ready", scheduled_at: when },
  body,
});

describe("PreviewGrid", () => {
  it("shows every variant of the campaign side by side, 12+ included", async () => {
    const extra = [
      ready("Mastodon", "mastodon", "ma/you", "Toot"),
      ready("Facebook", "facebook", "fb/event-x-berlin", "Hello Facebook"),
      ready("WhatsApp", "whatsapp", "wa/makers-berlin", "*Event X* tonight"),
      ready("Discord 2", "discord", "dc/maker-lab", "Doors open at 18:00"),
    ];
    const { ctx } = await makeCtx({ seed: true, notes: extra });
    render(PreviewGrid, { props: { campaign: readable(CAMPAIGN) }, context: osmmContext(ctx) });
    await vi.waitFor(() => expect(screen.getAllByRole("figure")).toHaveLength(13));
    expect(screen.getAllByRole("region", { name: /variant$/ })).toHaveLength(13);
    expect(screen.getByText(/^13 variants/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Instagram variant" }).textContent).toContain("event-x-cover.png was not found in the vault.");
    expect(screen.getByRole("button", { name: "Approve all ready (4)" })).toBeTruthy();
  });

  it("approves ready variants without blocking issues and offers undo", async () => {
    const good = ready("Mastodon", "mastodon", "ma/you", "Toot");
    const bad = ready("X 2", "x", "x/you", "a".repeat(300));
    const { ctx, index } = await makeCtx({ seed: true, notes: [good, bad] });
    expect(await ctx.composer.approveReady(index.variantsOf(CAMPAIGN))).toEqual({ approved: 1, skipped: 1 });
    await indexed(index, () => index.getVariant(good.path)?.status === "scheduled");
    expect(index.getVariant(good.path)?.deliveries).toEqual({ "ma/you": { status: "scheduled" } });
    expect(index.getVariant(bad.path)?.status).toBe("ready");
    expect(Notice.messages.at(-1)).toBe("Approved 1 post. Skipped 1 with blocking issues, no channel, or no future time. Undo");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => index.getVariant(good.path)?.status === "ready");
    expect(index.getVariant(good.path)?.deliveries).toEqual({});
  });

  it("opens from the campaign table with the campaign as view state", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    app.workspace.viewFactories.set(VIEW_PREVIEW_GRID, (leaf) => new PreviewGridView(leaf as never, ctx) as never);
    render(CampaignTable, { props: { campaignPath: CAMPAIGN }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Preview all" }));
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType(VIEW_PREVIEW_GRID)).toHaveLength(1));
    const view = app.workspace.getLeavesOfType(VIEW_PREVIEW_GRID)[0]!.view as unknown as PreviewGridView;
    expect(view.getState()).toEqual({ campaignPath: CAMPAIGN });
    await vi.waitFor(() => expect(view.contentEl.querySelectorAll("figure")).toHaveLength(9));
  });
});
