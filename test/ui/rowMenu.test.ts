import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Menu } from "../fakes/obsidian";
import { osmmContext } from "../../src/ui/context";
import BoardView from "../../src/views/BoardView.svelte";
import Chip from "../../src/views/Chip.svelte";
import ListView from "../../src/views/ListView.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "./ctx";

const BS = "Social/Event X/Event X – Bluesky.md";
const titles = () => Menu.last!.items.map((i) => i.title);
const click = (title: string) => Menu.last!.items.find((i) => i.title === title)!.click();

function touch(el: Element, type: string, x: number, y: number): void {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
  el.dispatchEvent(ev);
}

afterEach(() => {
  Menu.last = null;
  vi.useRealTimers();
});

describe("row menu", () => {
  it("offers every move for a scheduled post", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose", "Post now", "Reschedule…", "Move to Idea", "Move to Draft", "Move to Ready", "Skip"]);
  });

  it("offers only safe actions for a published channel", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey("Social/Event X/Event X – LinkedIn.md#li/me")!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose"]);
  });

  it("moves to a column with the same guards and undo as a drag", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    click("Move to Draft");
    await indexed(index, () => index.getVariant(BS)?.status === "draft");
  });

  it("reschedules through the date picker", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const target = new Date(2026, 9, 20, 11, 15).getTime();
    ctx.actions.pickTime = async () => target;
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    click("Reschedule…");
    await indexed(index, () => index.getVariant(BS)?.scheduledAt === target);
  });
});

describe("opening the menu without a mouse", () => {
  it("opens from the keyboard with Shift+F10 or the Menu key", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    await fireEvent.keyDown(chip, { key: "a" });
    expect(Menu.last).toBeNull();
    await fireEvent.keyDown(chip, { key: "F10", shiftKey: true });
    expect(titles()).toContain("Reschedule…");
    Menu.last = null;
    await fireEvent.keyDown(chip, { key: "ContextMenu" });
    expect(titles()).toContain("Reschedule…");
  });

  it("opens on right click", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    await fireEvent.contextMenu(screen.getByRole("button"));
    expect(titles()).toContain("Move to Draft");
  });

  it("opens on long press on phones and swallows the click that follows", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    vi.useFakeTimers();
    touch(chip, "touchstart", 10, 10);
    vi.advanceTimersByTime(500);
    expect(titles()).toContain("Skip");
    touch(chip, "touchend", 10, 10);
    const opened = app.workspace.opened.length;
    chip.click();
    expect(app.workspace.opened.length).toBe(opened);
  });

  it("does not open when the finger moves (scrolling)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(Chip, { props: { row: ctx.actions.rowByKey(`${BS}#bs/you`)! }, context: osmmContext(ctx) });
    const chip = screen.getByRole("button");
    vi.useFakeTimers();
    touch(chip, "touchstart", 10, 10);
    touch(chip, "touchmove", 10, 40);
    vi.advanceTimersByTime(600);
    expect(Menu.last).toBeNull();
  });

  it("opens from board cards and list rows", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const { unmount } = render(BoardView, { props: { variants: [index.getVariant(BS)!] }, context: osmmContext(ctx) });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Event X is back/ }));
    expect(titles()).toContain("Move to Ready");
    unmount();
    Menu.last = null;
    render(ListView, { props: { rows: [ctx.actions.rowByKey(`${BS}#bs/you`)!] }, context: osmmContext(ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Actions for Event X is back on the 12th — one evening, 80 makers." }));
    expect(titles()).toContain("Post now");
  });
});
