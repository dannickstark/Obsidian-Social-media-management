import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import QuickCreate, { validateQuickCreate } from "../../src/views/QuickCreate.svelte";
import { osmmContext } from "../../src/ui/context";
import { makeCtx } from "../ui/ctx";
import { settle } from "../helpers";

describe("validateQuickCreate", () => {
  it("requires a title for campaigns and a channel for posts", () => {
    expect(validateQuickCreate({ kind: "campaign", title: " " })).toEqual(["Give the campaign a title."]);
    expect(validateQuickCreate({ kind: "post", title: "Hi", platform: "x", channels: [] })).toEqual(["Pick at least one channel."]);
    expect(validateQuickCreate({ kind: "post", title: "Hi", platform: "x", channels: ["x/you"] })).toEqual([]);
  });
});

describe("QuickCreate", () => {
  it("creates a campaign and opens it", async () => {
    const { app, ctx, index } = await makeCtx();
    const close = vi.fn();
    render(QuickCreate, { props: { kind: "campaign", close }, context: osmmContext(ctx) });
    await fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Spring meetup" } });
    await fireEvent.input(screen.getByLabelText("Anchor date"), { target: { value: "2026-11-20" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await settle(5);
    expect(index.campaigns().map((c) => c.title)).toEqual(["Spring meetup"]);
    expect(app.workspace.opened.at(-1)?.linktext).toBe("Social/Spring meetup/Spring meetup.md");
    expect(close).toHaveBeenCalled();
  });

  it("shows validation errors instead of creating", async () => {
    const { ctx, index } = await makeCtx();
    render(QuickCreate, { props: { kind: "campaign", close: () => {} }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByRole("alert").textContent).toContain("Give the campaign a title.");
    expect(index.campaigns()).toEqual([]);
  });
});
