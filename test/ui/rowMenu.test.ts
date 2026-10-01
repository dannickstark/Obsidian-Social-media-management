import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Menu, Notice } from "../fakes/obsidian";
import { osmmContext } from "../../src/ui/context";
import BoardView from "../../src/views/BoardView.svelte";
import Chip from "../../src/views/Chip.svelte";
import ListView from "../../src/views/ListView.svelte";
import { indexed } from "../helpers";
import { makeCtx } from "./ctx";
import { formatDateTime, HOUR } from "../../src/model/dates";
import { TEST_NOW } from "./ctx";

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
  it("offers Push update, Revert time and Unschedule for an out-of-sync handed-over post, and labels its chip (#66)", async () => {
    const MA = "Social/Posts/Ma.md";
    const AT = TEST_NOW + 2 * HOUR;
    const { ctx } = await makeCtx({
      seed: true,
      notes: [{ path: MA, frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), remote_id: "3221", digest: "old" } } }, body: "Hi" }],
    });
    const row = ctx.actions.rowByKey(`${MA}#ma/you`)!;
    ctx.actions.rowMenu(row, { x: 0, y: 0 });
    expect(titles().slice(0, 5)).toEqual(["Open note", "Compose", "Push update", "Revert time", "Unschedule on Mastodon"]);
    const { container } = render(Chip, { props: { row }, context: osmmContext(ctx) });
    expect(container.querySelector(".osmm-chip-sync")).not.toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("out of sync with the platform");
  });

  it("offers every move for a scheduled post", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey(`${BS}#bs/you`)!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose", "Post now", "Reschedule…", "Move to Idea", "Move to Draft", "Move to Ready", "Skip"]);
  });

  it("offers only safe actions for a published channel, with no trailing separator", async () => {
    const { ctx } = await makeCtx({ seed: true });
    ctx.actions.rowMenu(ctx.actions.rowByKey("Social/Event X/Event X – LinkedIn.md#li/me")!, { x: 0, y: 0 });
    expect(titles()).toEqual(["Open note", "Compose"]);
    expect(Menu.last!.separators).toBe(0);
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

  it("anchors a keyboard-activated Actions button to the button's rect, not (0,0)", async () => {
    const { ctx } = await makeCtx({ seed: true });
    render(ListView, { props: { rows: [ctx.actions.rowByKey(`${BS}#bs/you`)!] }, context: osmmContext(ctx) });
    const button = screen.getByRole("button", { name: "Actions for Event X is back on the 12th — one evening, 80 makers." });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 40, bottom: 80, top: 0, right: 0, width: 0, height: 0, x: 40, y: 80, toJSON: () => undefined } as DOMRect);
    await fireEvent.click(button, { detail: 0 });
    expect(Menu.last!.pos).toEqual({ x: 40, y: 80 });
  });
});

describe("board card menu on a multi-channel card (final review Minor 11)", () => {
  const LI = "Social/Event X/Event X – LinkedIn.md";

  it("posts every postable channel of the card, not only the first", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const postNow = vi.spyOn(ctx.publish, "postNow").mockResolvedValue();
    render(BoardView, { props: { variants: [index.getVariant(LI)!] }, context: osmmContext(ctx) });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Event X/ }));
    click("Post now");
    expect(postNow).toHaveBeenCalledWith(LI, ["li/acme-studio", "li/maker-lab"]);
  });

  it("skips every postable channel of the card", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    ctx.actions.cardMenu(index.getVariant(LI)!, { x: 0, y: 0 });
    click("Skip");
    await indexed(index, () => index.getVariant(LI)?.deliveries["li/maker-lab"]?.status === "skipped" && index.getVariant(LI)?.deliveries["li/acme-studio"]?.status === "skipped");
    expect(index.getVariant(LI)!.deliveries["li/me"]?.status).toBe("published");
  });
});

describe("a note Claude wrote while Obsidian was closed (#84 fix round 1, I2/I3)", () => {
  const P = "Social/Event X/Event X – Mastodon.md";
  const offline = (over: Record<string, unknown> = {}) => ({
    path: P,
    frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "ready", review: "claude", scheduled_at: "2026-10-09T10:00:00+02:00", ...over },
    body: "Event X is back on the 12th.",
  });

  it("offers Review… instead of Post now (or Skip), and opens the composer", async () => {
    const { ctx, index } = await makeCtx({ seed: true, notes: [offline()] });
    const openComposer = vi.spyOn(ctx.composer, "openComposer").mockResolvedValue();
    ctx.actions.cardMenu(index.getVariant(P)!, { x: 0, y: 0 });
    const list = titles();
    expect(list).toContain("Review…");
    expect(list).not.toContain("Post now");
    expect(list).not.toContain("Skip");
    click("Review…");
    expect(openComposer).toHaveBeenCalledWith(P);
  });

  it("refuses Reschedule…, Move to … and drag with the same Notice", async () => {
    const { ctx, index } = await makeCtx({ seed: true, notes: [offline()] });
    const row = ctx.actions.rowByKey(`${P}#ma/you`)!;
    expect(await ctx.actions.reschedule(row, { at: Date.now() + 3_600_000 })).toBe(false);
    expect(Notice.messages.at(-1)).toBe("Approve it first in Written by Claude.");
    await ctx.actions.moveOnBoard(index.getVariant(P)!, "draft");
    expect(Notice.messages.at(-1)).toBe("Approve it first in Written by Claude.");
    expect(index.getVariant(P)!.status).toBe("ready");
  });
});
