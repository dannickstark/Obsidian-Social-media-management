import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../fakes/obsidian";
import { SvelteItemView } from "../../src/ui/SvelteView";
import Hello from "../fixtures/Hello.svelte";
import { makeCtx } from "./ctx";
import { Notice } from "../fakes/obsidian";

describe("SvelteItemView", () => {
  it("mounts on open and destroys on close", async () => {
    const { app, ctx } = await makeCtx();
    const onGone = vi.fn();
    class TestView extends SvelteItemView<{ name: string; onGone: () => void }> {
      getViewType() {
        return "test";
      }
      getDisplayText() {
        return "Test";
      }
      protected component() {
        return Hello;
      }
      protected props() {
        return { name: "Ada", onGone };
      }
    }
    const view = new TestView(new WorkspaceLeaf(app as never) as never, ctx);
    await view.onOpen();
    expect(view.contentEl.textContent).toContain("Hello, Ada!");
    expect(view.contentEl.classList.contains("osmm")).toBe(true);
    await view.onClose();
    expect(onGone).toHaveBeenCalledOnce();
  });
});

describe("PlannerActions basics", () => {
  it("opens notes and labels rows", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.channelId === "li/acme-studio")!;
    expect(ctx.actions.rowLabel(row)).toMatch(/^LinkedIn · Acme Studio · .+ \d\d:\d\d · Waiting for you — I almost didn't host Event X\.$/);
    ctx.actions.openNote(row.variant.path, true);
    expect(app.workspace.opened).toEqual([{ linktext: row.variant.path, newLeaf: true }]);
    expect(ctx.actions.rowByKey(row.key)).toBe(row);
  });

  it("offers undo in a notice", async () => {
    const { ctx } = await makeCtx();
    const undo = vi.fn();
    ctx.actions.undoNotice("Moved", undo);
    Notice.last!.noticeEl.querySelector("button")!.click();
    expect(undo).toHaveBeenCalledOnce();
    expect(Notice.last!.hidden).toBe(true);
  });
});
