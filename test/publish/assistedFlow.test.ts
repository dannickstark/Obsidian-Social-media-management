import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { MarkdownView, Modal, Notice, WorkspaceLeaf } from "../fakes/obsidian";
import { browser } from "../fakes/browser";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import AssistedFlow from "../../src/publish/AssistedFlow.svelte";
import { assistedQueue } from "../../src/publish/assistedFlow";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const BS = "Social/Event X/Event X – Bluesky.md";

describe("assistedQueue", () => {
  it("lists the channels still to post, in stagger order", async () => {
    const { index } = await makeCtx({ seed: true });
    expect(assistedQueue(index.getVariant(LI)!, 15)).toEqual(["li/acme-studio", "li/maker-lab"]);
    const v = index.getVariant(LI)!;
    const swapped = { ...v, deliveries: { ...v.deliveries, "li/acme-studio": { status: "scheduled" as const, at: 3_000_000_000_000 } } };
    expect(assistedQueue(swapped, 15)).toEqual(["li/maker-lab", "li/acme-studio"]);
    expect(assistedQueue(v, 15, ["li/maker-lab", "li/me"])).toEqual(["li/maker-lab"]);
  });
});

describe("AssistedFlow", () => {
  it("walks each channel through check, open and confirm", async () => {
    const c = await makeCtx({ seed: true });
    const close = vi.fn();
    render(AssistedFlow, { props: { path: LI, channelIds: ["li/acme-studio", "li/maker-lab"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("figure", { name: "LinkedIn preview" })).toBeTruthy());
    expect(screen.getByText("LinkedIn · Acme Studio (1 of 2)")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open LinkedIn" }));
    await vi.waitFor(() => expect(browser.opened).toEqual(["https://www.linkedin.com/feed/"]));
    expect(browser.clipboard[0]).toEqual({ kind: "text", text: "I almost didn't host Event X.\n\nSix months ago I was shipping alone…" });

    await fireEvent.click(screen.getByRole("button", { name: "I've posted it" }));
    await fireEvent.input(screen.getByLabelText("Link to the live post"), { target: { value: "https://x.com/nope" } });
    await fireEvent.click(screen.getByRole("button", { name: "Mark published" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That isn't a LinkedIn link (expected linkedin.com)."));
    await fireEvent.input(screen.getByLabelText("Link to the live post"), { target: { value: "https://www.linkedin.com/feed/update/urn:li:activity:2" } });
    await fireEvent.click(screen.getByRole("button", { name: "Mark published" }));
    await indexed(c.index, () => c.index.getVariant(LI)!.deliveries["li/acme-studio"]?.status === "published");
    await vi.waitFor(() => expect(screen.getByText("LinkedIn · Maker Lab (2 of 2)")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open LinkedIn" }));
    await indexed(c.index, () => c.index.getVariant(LI)!.deliveries["li/maker-lab"]?.status === "awaiting_you");
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledOnce();
    expect(c.index.getVariant(LI)!.deliveries["li/maker-lab"]?.status).toBe("awaiting_you");
  });

  it("offers the further clipboard items, then skips with a reason", async () => {
    const c = await makeCtx({ seed: true });
    const close = vi.fn();
    const X = "Social/Event X/Event X – X.md";
    render(AssistedFlow, { props: { path: X, channelIds: ["x/you"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Copy reply 2" }));
    await vi.waitFor(() => expect(browser.clipboard).toEqual([{ kind: "text", text: "One evening, twelve makers…" }]));
    await fireEvent.click(screen.getByRole("button", { name: "I've posted it" }));
    await fireEvent.input(screen.getByLabelText("Reason (optional)"), { target: { value: "Posted from my phone" } });
    await fireEvent.click(screen.getByRole("button", { name: "Skip this channel" }));
    await indexed(c.index, () => c.index.getVariant(X)!.deliveries["x/you"]?.status === "skipped");
    expect(c.index.getVariant(X)!.deliveries["x/you"]).toEqual({ status: "skipped", reason: "Posted from my phone" });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("Copy & open", () => {
  it("opens the flow from the composer for the pending channels", async () => {
    const c = await makeCtx({ seed: true });
    render(ActionsBar, { props: { variant: c.index.getVariant(BS)! }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Copy & open" }));
    expect(Modal.opened.at(-1)?.titleEl.textContent).toBe("Post");
    expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("Bluesky · @you.bsky.social (1 of 1)");
    Modal.opened.at(-1)?.close();
  });

  it("says when nothing is left to post", async () => {
    const c = await makeCtx({ seed: true });
    expect(c.ctx.publish.openAssisted("Social/Posts/Weekly devlog 12.md")).toBe(false);
    expect(Notice.messages.at(-1)).toBe("Nothing left to post for this note.");
  });

  it("can open straight at the confirm step", async () => {
    const c = await makeCtx({ seed: true });
    expect(c.ctx.publish.openAssisted(BS, ["bs/you"], 3)).toBe(true);
    expect(Modal.opened.at(-1)?.contentEl.querySelector("input[type=url]")).not.toBeNull();
    Modal.opened.at(-1)?.close();
  });
});

describe("Copy & open (P3: composer editor flush)", () => {
  it("copies the editor buffer, not the stale file on disk", async () => {
    const c = await makeCtx({ seed: true });
    const file = c.app.vault.getFileByPath(BS)!;
    const leaf = new WorkspaceLeaf(c.app);
    const md = new MarkdownView(leaf);
    md.file = file;
    md.editor = { getValue: () => "---\ntype: social-post\nplatform: bluesky\nstatus: scheduled\nchannels:\n  - bs/you\nscheduled_at: 2026-10-08T11:00:00.000Z\n---\nEvent X is back — buffer text, not yet saved.\n" };
    leaf.view = md;
    leaf.viewType = "markdown";
    c.app.workspace.leaves.push(leaf);

    const close = vi.fn();
    render(AssistedFlow, { props: { path: BS, channelIds: ["bs/you"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: /Open Bluesky|Copy the text/ }));
    await vi.waitFor(() => expect(browser.clipboard.length).toBeGreaterThan(0));
    expect(browser.clipboard[0]).toEqual({ kind: "text", text: "Event X is back — buffer text, not yet saved." });
    expect(await c.app.vault.cachedRead(file)).toContain("buffer text, not yet saved.");
  });

  it("refuses to copy or open when the buffer fails validation", async () => {
    const c = await makeCtx({ seed: true });
    const file = c.app.vault.getFileByPath(BS)!;
    const leaf = new WorkspaceLeaf(c.app);
    const md = new MarkdownView(leaf);
    md.file = file;
    md.editor = { getValue: () => "---\ntype: social-post\nplatform: bluesky\nstatus: scheduled\nchannels:\n  - bs/you\nscheduled_at: 2026-10-08T11:00:00.000Z\n---\n" };
    leaf.view = md;
    leaf.viewType = "markdown";
    c.app.workspace.leaves.push(leaf);

    const close = vi.fn();
    render(AssistedFlow, { props: { path: BS, channelIds: ["bs/you"], close }, context: osmmContext(c.ctx) });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const before = Notice.messages.length;
    await fireEvent.click(screen.getByRole("button", { name: /Open Bluesky|Copy the text/ }));
    await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(before));
    expect(browser.clipboard).toEqual([]);
    expect(browser.opened).toEqual([]);
  });
});

describe("openTarget", () => {
  it("refuses to copy or open when the variant was removed from the index before the Open click", async () => {
    const c = await makeCtx({ seed: true });
    await c.app.vault.delete(c.app.vault.getFileByPath(BS)!);
    await indexed(c.index, () => c.index.getVariant(BS) === undefined);

    const before = Notice.messages.length;
    const result = await c.ctx.publish.openTarget(BS, "bs/you");
    expect(result).toBeNull();
    expect(Notice.messages.length).toBeGreaterThan(before);
    expect(browser.clipboard).toEqual([]);
    expect(browser.opened).toEqual([]);
    expect(c.log.entries.some((e) => e.channelId === "bs/you" && e.result === "awaiting_you")).toBe(false);
  });
});
