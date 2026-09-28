import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Menu, Notice } from "../fakes/obsidian";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const FORK = "Social/Event X/Event X – LinkedIn – Acme Studio.md";

describe("ActionsBar", () => {
  it("forks one channel into its own note and offers to open it", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const open = vi.spyOn(ctx.composer, "openComposer").mockResolvedValue();
    render(ActionsBar, { props: { variant: index.getVariant(LI)! }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Fork for this page…" }));
    expect(Menu.last!.items.map((i) => i.title)).toEqual(["Me", "Acme Studio", "Maker Lab"]);
    Menu.last!.items[1]!.click();
    await indexed(index, () => index.getVariant(FORK) !== undefined && index.getVariant(LI)!.channels.length === 2);
    expect(index.getVariant(FORK)!.channels).toEqual(["li/acme-studio"]);
    expect(index.getVariant(FORK)!.deliveries["li/acme-studio"]?.status).toBe("awaiting_you");
    expect(index.getVariant(LI)!.channels).toEqual(["li/me", "li/maker-lab"]);
    expect(Notice.messages.at(-1)).toBe("Forked Acme Studio into its own note. Open in composer");
    Notice.last!.noticeEl.querySelector("button")!.click();
    expect(open).toHaveBeenCalledWith(FORK);
  });

  it("keeps the scheduled times when forking from the composer (cross-task b)", async () => {
    const path = "Social/Posts/Pages.md";
    const { ctx, index } = await makeCtx({
      seed: true,
      notes: [
        {
          path,
          frontmatter: {
            type: "social-post", platform: "linkedin", title: "Pages", channels: ["li/acme-studio", "li/maker-lab", "li/osmm"], stagger_minutes: 30, status: "scheduled",
            scheduled_at: "2026-10-09T10:00:00+02:00",
            deliveries: { "li/acme-studio": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" }, "li/osmm": { status: "scheduled" } },
          },
          body: "Hello makers\n",
        },
      ],
    });
    const fork = await ctx.composer.fork(index.getVariant(path)!, "li/maker-lab");
    await indexed(index, () => fork !== null && index.getVariant(fork) !== undefined && index.getVariant(path)!.channels.length === 2);
    expect(index.getVariant(fork!)!.deliveries["li/maker-lab"]).toEqual({ status: "scheduled", at: Date.parse("2026-10-09T10:30:00+02:00") });
    expect(index.getVariant(path)!.deliveries["li/acme-studio"]).toEqual({ status: "scheduled" });
    expect(index.getVariant(path)!.deliveries["li/osmm"]).toEqual({ status: "scheduled", at: Date.parse("2026-10-09T11:00:00+02:00") });
  });

  it("offers no fork for a single-channel post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(ActionsBar, { props: { variant: index.getVariant("Social/Event X/Event X – X.md")! }, context: osmmContext(ctx) });
    expect(screen.queryByRole("button", { name: "Fork for this page…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview campaign" })).toBeTruthy();
  });

  it("explains a failed fork", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    vi.spyOn(ctx.composer["deps"].factory, "forkVariant").mockRejectedValue(new Error("Cannot fork the only channel of a post"));
    expect(await ctx.composer.fork(index.getVariant(LI)!, "li/me")).toBeNull();
    expect(Notice.messages.at(-1)).toBe("Cannot fork the only channel of a post");
  });
});
