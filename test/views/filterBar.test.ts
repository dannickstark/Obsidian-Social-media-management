import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { Menu } from "../fakes/obsidian";
import FilterBar from "../../src/views/FilterBar.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";

describe("FilterBar", () => {
  it("filters by platform through a checkable menu and clears", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(FilterBar, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Platform" }));
    const item = Menu.last!.items.find((i) => i.title === "LinkedIn")!;
    expect(item.checked).toBe(false);
    item.click();
    await tick();
    expect(get(ctx.viewState).filter.platforms).toEqual(["linkedin"]);
    expect(screen.getByRole("button", { name: "Platform (1)" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(get(ctx.viewState).filter.platforms).toEqual([]);
  });

  it("lists channel groups before channels", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(FilterBar, { context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(Menu.last!.items[0]!.title).toBe("All LinkedIn pages (group)");
  });
});
