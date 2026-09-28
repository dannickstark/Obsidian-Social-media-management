import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../fakes/obsidian";
import { SvelteItemView } from "../../src/ui/SvelteView";
import Hello from "../fixtures/Hello.svelte";
import { formatDateTime } from "../../src/model/dates";
import { makeCtx, TEST_NOW } from "./ctx";
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

  it("recomputes row times when the default stagger changes", async () => {
    const { ctx, settings } = await makeCtx({
      notes: [
        {
          path: "Social/Posts/Multi.md",
          frontmatter: {
            type: "social-post",
            platform: "linkedin",
            channels: ["li/me", "li/acme-studio"],
            scheduled_at: formatDateTime(TEST_NOW),
          },
        },
      ],
    });
    const before = ctx.actions.rows().find((r) => r.key === "Social/Posts/Multi.md#li/acme-studio")!;
    expect(before.at).toBe(TEST_NOW + get(settings).defaultStaggerMinutes * 60_000);

    settings.update((s) => ({ ...s, defaultStaggerMinutes: s.defaultStaggerMinutes + 30 }));
    const after = ctx.actions.rowByKey("Social/Posts/Multi.md#li/acme-studio")!;
    expect(after.at).toBe(TEST_NOW + (before.variant.channels.indexOf("li/acme-studio")) * (get(settings).defaultStaggerMinutes) * 60_000);
    expect(after.at).not.toBe(before.at);
  });
});
