import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Planner from "../../src/views/Planner.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("Planner — month", () => {
  it("renders the current month with chips on the right days", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
    const today = document.querySelector('[data-day="2026-10-08"]')!;
    expect(today.textContent).toContain("Event X is back");
    expect(document.querySelector('[data-day="2026-10-12"] .osmm-anchor')?.textContent).toBe("Event X");
  });

  it("opens the note when a chip is clicked", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    const chip = screen.getAllByRole("button", { name: /^Bluesky/ })[0]!;
    await fireEvent.click(chip);
    expect(app.workspace.opened[0]?.linktext).toBe("Social/Event X/Event X – Bluesky.md");
  });

  it("navigates months", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "November 2026" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
  });

  it("collapses busy days into a '+N more' menu", async () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({
      path: `Social/Posts/P${i}.md`,
      frontmatter: { type: "social-post", platform: "x", title: `P${i}`, scheduled_at: `2026-10-20 1${i}:00` },
    }));
    const { ctx } = await makeCtx({ notes });
    render(Planner, { context: osmmContext(ctx) });
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
  });
});
