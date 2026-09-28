import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Planner from "../../src/views/Planner.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("Planner — week", () => {
  it("switches to week mode and positions chips by time", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("heading").textContent).toMatch(/Oct 5 – Oct 11, 2026/);
    const item = document.querySelector('[data-row-key="Social/Event X/Event X – Bluesky.md#bs/you"]') as HTMLElement;
    expect(item.style.top).toBe(`${11 * 60 * 0.8}px`);
  });
});
