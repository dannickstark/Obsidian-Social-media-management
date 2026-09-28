import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Notice } from "../fakes/obsidian";
import PostAs from "../../src/composer/PostAs.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";

describe("PostAs", () => {
  it("refuses to deselect a published channel and leaves its delivery untouched (review focus 4)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const before = structuredClone(index.getVariant(LI)!.deliveries);
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    expect(screen.getByRole("button", { name: "Me" }).getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: "Me" }));
    await vi.waitFor(() => expect(Notice.messages.at(-1)).toBe("Me was already published, so it stays on this post."));
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio", "li/maker-lab"]);
    expect(index.getVariant(LI)!.deliveries).toEqual(before);
  });

  it("adds a channel with the post's delivery status, and undoes it", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "OSMM" }));
    await indexed(index, () => index.getVariant(LI)!.channels.includes("li/osmm"));
    expect(index.getVariant(LI)!.deliveries["li/osmm"]).toEqual({ status: "scheduled" });
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => !index.getVariant(LI)!.channels.includes("li/osmm"));
    expect(index.getVariant(LI)!.deliveries["li/osmm"]).toBeUndefined();
  });

  it("adds a group's channels and sets the stagger", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(PostAs, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Add group: All LinkedIn pages" }));
    await indexed(index, () => index.getVariant(LI)!.channels.length === 5);
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    await fireEvent.change(screen.getByLabelText("Minutes between channels"), { target: { value: "30" } });
    await indexed(index, () => index.getVariant(LI)!.staggerMinutes === 30);
    expect(index.getVariant(LI)!.staggerMinutes).toBe(30);
  });
});
