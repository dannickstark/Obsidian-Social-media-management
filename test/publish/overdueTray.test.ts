import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { getFrontMatterInfo } from "obsidian";
import { MarkdownView, Modal, Notice, WorkspaceLeaf } from "../fakes/obsidian";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import { VIEW_SIDEBAR } from "../../src/ui/actions";
import { osmmContext } from "../../src/ui/context";
import CampaignTable from "../../src/views/CampaignTable.svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const IG = "Social/Event X/Event X – Instagram.md";
const TG = "Social/Event X/Event X – Telegram.md";
const CHECK = "Social/Posts/Check.md";
const checkNote = {
  path: CHECK,
  frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "attention", deliveries: { "tg/event-x": { status: "check_needed" } } },
  body: "Doors open",
};
// The seeded Instagram note is overdue but has a genuine blocking issue (its cover image is missing from
// the vault, per test/previews/grid.test.ts); it now exercises the P3 refusal below. This note is overdue
// too, but has no blocking issues, so it exercises the success path instead.
const MASTODON = "Social/Event X/Event X – Mastodon.md";
const overdueNote = {
  path: MASTODON,
  frontmatter: {
    type: "social-post",
    campaign: "[[Event X]]",
    platform: "mastodon",
    status: "overdue",
    channels: ["ma/you"],
    scheduled_at: "2026-10-06T18:00:00+02:00",
    deliveries: { "ma/you": { status: "overdue" } },
  },
  body: "Event X was earlier this week — thanks for coming!",
};

describe("Overdue tray", () => {
  it("posts an overdue item now through the assisted flow", async () => {
    const c = await makeCtx({ seed: true, notes: [overdueNote] });
    render(Sidebar, { context: osmmContext(c.ctx) });
    const tray = screen.getByRole("region", { name: /Overdue/ });
    await fireEvent.click(within(tray).getByRole("button", { name: "Post Event X was earlier this week — thanks for coming! now" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Mastodon · @you@mastodon.social (1 of 1)"));
    Modal.opened.at(-1)?.close();
  });

  it("posts through the API where an adapter exists", async () => {
    const c = await makeCtx({ seed: true });
    const DC = "Social/Event X/Event X – Discord.md";
    c.adapters.register({ platform: "discord", publish: async () => ({ remoteId: "1", url: "https://discord.com/channels/1/2/3" }) });
    await c.ctx.publish.postNow(DC);
    await indexed(c.index, () => c.index.getVariant(DC)?.status === "published");
  });

  it("refuses to post an overdue item with a blocking issue (ruling P3)", async () => {
    const c = await makeCtx({ seed: true });
    const publish = vi.fn().mockResolvedValue({ remoteId: "1", url: "https://www.instagram.com/p/1" });
    c.adapters.register({ platform: "instagram", publish });
    render(Sidebar, { context: osmmContext(c.ctx) });
    const tray = screen.getByRole("region", { name: /Overdue/ });
    const openModals = Modal.opened.length;
    await fireEvent.click(within(tray).getByRole("button", { name: "Post One evening. Eighty makers. Laptops open. now" }));
    expect(Notice.messages.at(-1)).toContain("Instagram needs an image.");
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(IG)?.status).toBe("overdue");
    expect(Modal.opened.length).toBe(openModals);
  });

  it("flushes an open editor before an API delivery, so it sends the exact text on screen (ruling P3)", async () => {
    const c = await makeCtx({ seed: true });
    const X = "Social/Event X/Event X – X.md";
    const file = c.app.vault.getFileByPath(X)!;
    const raw = await c.app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const buffer = `${raw.slice(0, info.contentStart)}Fresh buffer text, not yet saved.\n`;
    const leaf = new WorkspaceLeaf(c.app);
    const md = new MarkdownView(leaf);
    md.file = file;
    md.editor = { getValue: () => buffer };
    leaf.view = md;
    leaf.viewType = "markdown";
    c.app.workspace.leaves.push(leaf);

    let sentText = "";
    c.adapters.register({
      platform: "x",
      publish: async (job) => {
        sentText = job.text;
        return { remoteId: "1", url: "https://x.com/you/status/1" };
      },
    });
    await c.ctx.publish.postNow(X, ["x/you"]);
    await indexed(c.index, () => c.index.getVariant(X)?.deliveries["x/you"]?.status === "published");
    expect(sentText).toBe("Fresh buffer text, not yet saved.");
  });

  it("updates its count live", async () => {
    const c = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Overdue · 2" })).toBeTruthy();
    await c.ctx.publish.skip(IG, "ig/acmestudio");
    await vi.waitFor(() => expect(screen.getByRole("region", { name: "Overdue · 1" })).toBeTruthy());
  });

  it("shows a startup banner that opens the queue", async () => {
    const c = await makeCtx({ seed: true });
    c.ctx.publish.overdueBanner(2);
    expect(Notice.messages.at(-1)).toBe("2 posts are overdue. Review");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType(VIEW_SIDEBAR)).toHaveLength(1));
    const count = Notice.messages.length;
    c.ctx.publish.overdueBanner(0);
    expect(Notice.messages.length).toBe(count);
  });
});

describe("Needs attention", () => {
  it("offers Post again and Fix for a failed delivery", async () => {
    const c = await makeCtx({ seed: true });
    const open = vi.spyOn(c.ctx.composer, "openComposer").mockResolvedValue();
    render(Sidebar, { context: osmmContext(c.ctx) });
    const section = screen.getByRole("region", { name: "Needs attention · 1" });
    expect(section.textContent).toContain("Bot is not an admin of the channel");
    await fireEvent.click(within(section).getByRole("button", { name: "Fix" }));
    expect(open).toHaveBeenCalledWith(TG);
    await fireEvent.click(within(section).getByRole("button", { name: "Post again" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Telegram · Event X channel (1 of 1)"));
    Modal.opened.at(-1)?.close();
  });

  it("offers Check again for a check-needed delivery (check_needed recovery ruling)", async () => {
    const c = await makeCtx({ seed: true, notes: [checkNote] });
    const spy = vi.spyOn(c.ctx.publish, "resolveCheck").mockResolvedValue();
    render(Sidebar, { context: osmmContext(c.ctx) });
    const section = screen.getByRole("region", { name: "Needs attention · 2" });
    await fireEvent.click(within(section).getByRole("button", { name: "Check again" }));
    expect(spy).toHaveBeenCalledWith(CHECK, "tg/event-x");
  });

  it("resolves a check-needed delivery either way", async () => {
    const c = await makeCtx({ seed: true, notes: [checkNote] });
    render(Sidebar, { context: osmmContext(c.ctx) });
    const section = screen.getByRole("region", { name: "Needs attention · 2" });
    await fireEvent.click(within(section).getByRole("button", { name: "It went out" }));
    expect(Modal.opened.at(-1)?.contentEl.querySelector("input[type=url]")).not.toBeNull();
    Modal.opened.at(-1)?.close();
    await fireEvent.click(within(section).getByRole("button", { name: "It didn't" }));
    await indexed(c.index, () => c.index.getVariant(CHECK)?.deliveries["tg/event-x"]?.status === "failed");
    expect(c.index.getVariant(CHECK)!.deliveries["tg/event-x"]?.error).toBe("Not published (checked by you).");
  });
});

describe("Campaign table Post now", () => {
  it("posts an overdue variant from the social-variants table", async () => {
    const c = await makeCtx({ seed: true, notes: [overdueNote] });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Post Mastodon variant now" }));
    await vi.waitFor(() => expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Mastodon · @you@mastodon.social (1 of 1)"));
    Modal.opened.at(-1)?.close();
    expect(screen.queryByRole("button", { name: "Post X variant now" })).toBeNull();
  });

  it("refuses to post an overdue variant with a blocking issue (ruling P3)", async () => {
    const c = await makeCtx({ seed: true });
    const publish = vi.fn().mockResolvedValue({ remoteId: "1", url: "https://www.instagram.com/p/1" });
    c.adapters.register({ platform: "instagram", publish });
    render(CampaignTable, { props: { campaignPath: "Social/Event X/Event X.md" }, context: osmmContext(c.ctx) });
    const openModals = Modal.opened.length;
    await fireEvent.click(screen.getByRole("button", { name: "Post Instagram variant now" }));
    expect(Notice.messages.at(-1)).toContain("Instagram needs an image.");
    expect(publish).not.toHaveBeenCalled();
    expect(c.index.getVariant(IG)?.status).toBe("overdue");
    expect(Modal.opened.length).toBe(openModals);
  });
});

describe("Composer Post now", () => {
  it("is disabled while there are blocking issues", async () => {
    const c = await makeCtx({ seed: true });
    const issues = [{ level: "error" as const, field: "media", message: "Instagram needs an image." }];
    render(ActionsBar, { props: { variant: c.index.getVariant(IG)!, issues }, context: osmmContext(c.ctx) });
    expect((screen.getByRole("button", { name: "Post now" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy & open" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when nothing is left to post", async () => {
    const c = await makeCtx({ seed: true });
    await c.ctx.publish.postNow("Social/Posts/Weekly devlog 12.md");
    expect(Notice.messages.at(-1)).toBe("Nothing left to post for this note.");
  });
});
