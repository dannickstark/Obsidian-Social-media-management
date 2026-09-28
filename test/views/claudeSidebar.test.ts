import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { makeCtx } from "../ui/ctx";

const note = (path: string, body: string) => ({
  path,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "ready", review: "claude", scheduled_at: "2026-10-09T10:00:00+02:00" },
  body,
});

describe("Written by Claude (#84)", () => {
  it("lists held notes with their first blocking issue, and approves the valid one", async () => {
    const { ctx, index } = await makeCtx({ seed: true, notes: [note("Social/Event X/A.md", "Short and fine."), note("Social/Event X/B.md", "a".repeat(600))] });
    render(Sidebar, { context: osmmContext(ctx) });
    const section = screen.getByRole("region", { name: "Written by Claude · 2" });
    expect(await screen.findByText("The text is 600/500 characters.")).toBeTruthy();
    expect(section.textContent).toContain("Ready for");
    const approve = screen.getAllByRole("button", { name: /^Approve and schedule/ });
    expect(approve.map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true]);
    await fireEvent.click(approve[0]!);
    await indexed(index, () => index.getVariant("Social/Event X/A.md")?.review === undefined);
    expect(index.getVariant("Social/Event X/A.md")!.status).toBe("scheduled");
  });

  it("shows a past proposed time and disables Approve (#84 fix round 1, m5)", async () => {
    await makeCtx({
      seed: true,
      notes: [{ ...note("Social/Event X/Late.md", "Short and fine."), frontmatter: { ...note("Social/Event X/Late.md", "x").frontmatter, scheduled_at: "2026-10-08T07:00:00+02:00" } }],
    }).then(({ ctx }) => render(Sidebar, { context: osmmContext(ctx) }));
    expect(await screen.findByText("The proposed time has passed")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Approve and schedule/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not re-check a held note's issues on every unrelated snapshot update (#84 fix round 1, m5)", async () => {
    const { ctx, index } = await makeCtx({ seed: true, notes: [note("Social/Event X/A.md", "Short and fine.")] });
    const spy = vi.spyOn(ctx.composer, "reviewIssues");
    render(Sidebar, { context: osmmContext(ctx) });
    await screen.findByText(/Ready for/);
    const calls = spy.mock.calls.length;
    await ctx.actions.skip(ctx.actions.rowByKey("Social/Event X/Event X – Bluesky.md#bs/you")!);
    await indexed(index, () => index.getVariant("Social/Event X/Event X – Bluesky.md")?.deliveries["bs/you"]?.status === "skipped");
    expect(spy.mock.calls.length).toBe(calls);
    expect(screen.getByRole("button", { name: /^Approve and schedule/ })).toBeTruthy();
  });
});
