import { describe, expect, it } from "vitest";
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
});
