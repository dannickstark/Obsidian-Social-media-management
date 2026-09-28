import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Sidebar from "../../src/views/Sidebar.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { indexed } from "../helpers";

describe("Sidebar", () => {
  it("lists overdue posts, today's queue and campaign progress", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(ctx) });
    const overdue = screen.getByRole("region", { name: /Overdue/ });
    expect(overdue.textContent).toContain("One evening. Eighty makers.");
    expect(overdue.textContent).toContain("Show HN: Event X");
    expect(screen.getByRole("region", { name: "Up next · today" }).textContent).toContain("Event X is back");
    expect(screen.getByRole("region", { name: "Campaigns" }).textContent).toMatch(/Event X\s*1\/\d+/);
  });

  it("skips an overdue post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    render(Sidebar, { context: osmmContext(ctx) });
    const buttons = screen.getAllByRole("button", { name: /^Skip/ });
    await fireEvent.click(buttons[0]!);
    await indexed(index, () => index.getVariant("Social/Event X/Event X – Instagram.md")?.deliveries["ig/acmestudio"]?.status === "skipped");
    expect(index.getVariant("Social/Event X/Event X – Instagram.md")?.deliveries["ig/acmestudio"]?.status).toBe("skipped");
  });
});
