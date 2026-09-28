import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { MarkdownView, WorkspaceLeaf } from "../fakes/obsidian";
import { ComposerView } from "../../src/composer/ComposerView";
import { composerSession } from "../../src/composer/session";
import { VIEW_COMPOSER } from "../../src/ui/actions";
import { settle, writeNote } from "../helpers";
import { makeCtx, type TestCtx } from "../ui/ctx";

const LI = "Social/Event X/Event X – LinkedIn.md";
const BS = "Social/Event X/Event X – Bluesky.md";

function register(c: TestCtx): void {
  c.app.workspace.viewFactories.set(VIEW_COMPOSER, (leaf) => new ComposerView(leaf as never, c.ctx) as never);
}

async function openView(c: TestCtx, path: string): Promise<ComposerView> {
  register(c);
  const leaf = new WorkspaceLeaf(c.app);
  await leaf.setViewState({ type: VIEW_COMPOSER, state: { path } });
  return leaf.view as unknown as ComposerView;
}

describe("Composer shell", () => {
  it("previews the note and updates within 150 ms of typing", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, BS);
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Event X is back on the 12th"));
    const file = c.app.vault.getFileByPath(BS)!;
    c.app.workspace.trigger("editor-change", { getValue: () => "---\ntype: social-post\n---\nFresh words from the editor" }, { file });
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Fresh words from the editor"), { timeout: 150, interval: 5 });
  });

  it("ignores typing in other notes", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, BS);
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Event X is back on the 12th"));
    c.app.workspace.trigger("editor-change", { getValue: () => "Other note" }, { file: c.app.vault.getFileByPath(LI) });
    await settle(130);
    expect(view.contentEl.textContent).not.toContain("Other note");
  });

  it("falls back gracefully for a note that is not a social post", async () => {
    const c = await makeCtx({ seed: true });
    await writeNote(c.app as never, "Notes/Plain.md", { title: "Just a note" }, "Hello");
    const view = await openView(c, "Notes/Plain.md");
    expect(view.contentEl.textContent).toContain("Open a social post note to compose it here.");
  });

  it("shows a tab per campaign variant and switches the note in the editor", async () => {
    const c = await makeCtx({ seed: true });
    const view = await openView(c, LI);
    const editor = new WorkspaceLeaf(c.app);
    view.editorLeaf = editor as never;
    const tabs = within(view.contentEl).getAllByRole("tab");
    expect(tabs).toHaveLength(9);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual(["inLinkedIn"]);
    await fireEvent.click(tabs.find((t) => t.textContent?.includes("Bluesky"))!);
    await vi.waitFor(() => expect(view.getState()).toEqual({ path: BS }));
    expect(editor.file?.path).toBe(BS);
  });

  it("keeps the newest note's body when switching quickly", async () => {
    const c = await makeCtx({ seed: true });
    const read = c.app.vault.cachedRead.bind(c.app.vault);
    vi.spyOn(c.app.vault, "cachedRead").mockImplementation(async (file) => {
      if (file.path === LI) await settle(30);
      return read(file);
    });
    const session = composerSession(c.app as never, c.index);
    session.path.set(LI);
    session.path.set(BS);
    await settle(60);
    expect(get(session.body).path).toBe(BS);
    expect(get(session.body).text).toContain("Event X is back on the 12th");
    session.dispose();
  });

  it("never shows or checks the previous note's body while the next one is loading", async () => {
    const c = await makeCtx({ seed: true });
    const checked: Array<[string, string]> = [];
    const counted: Array<[string, string]> = [];
    const check = c.ctx.composer.check.bind(c.ctx.composer);
    const count = c.ctx.composer.counters.bind(c.ctx.composer);
    vi.spyOn(c.ctx.composer, "check").mockImplementation((v, content) => {
      checked.push([v.path, content.body]);
      return check(v, content);
    });
    vi.spyOn(c.ctx.composer, "counters").mockImplementation((v, content, ch) => {
      counted.push([v.path, content.body]);
      return count(v, content, ch);
    });
    const view = await openView(c, BS);
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("Event X is back on the 12th"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = c.app.vault.cachedRead.bind(c.app.vault);
    vi.spyOn(c.app.vault, "cachedRead").mockImplementation(async (file) => {
      if (file.path === LI) await gate;
      return read(file);
    });
    await view.showVariant(LI);
    await settle(30);
    expect(view.contentEl.textContent).not.toContain("Event X is back on the 12th");
    expect(view.contentEl.textContent).toContain("Loading…");
    expect(within(view.contentEl).queryByRole("region", { name: "Checks" })).toBeNull();
    release();
    await vi.waitFor(() => expect(view.contentEl.textContent).toContain("I almost didn't host Event X."));
    expect(view.contentEl.textContent).not.toContain("Loading…");
    for (const [path, body] of [...checked, ...counted]) {
      if (path === LI) expect(body).not.toContain("Event X is back on the 12th");
      if (path === BS) expect(body).not.toContain("I almost didn't host");
    }
    expect(checked.some(([path]) => path === LI)).toBe(true);
  });

  it("prefers the open editor's buffer over the file on disk", async () => {
    const c = await makeCtx({ seed: true });
    const leaf = new WorkspaceLeaf(c.app);
    const md = new MarkdownView(leaf);
    md.file = c.app.vault.getFileByPath(BS);
    md.editor = { getValue: () => "---\ntype: social-post\n---\nNewer words, not saved yet" };
    leaf.view = md;
    leaf.viewType = "markdown";
    c.app.workspace.leaves.push(leaf);
    const session = composerSession(c.app as never, c.index);
    session.path.set(BS);
    await settle(10);
    expect(get(session.body)).toEqual({ path: BS, text: "Newer words, not saved yet" });
    await c.writer.run(c.app.vault.getFileByPath(BS)! as never, (fm) => {
      fm.stagger_minutes = 5;
    });
    await settle(30);
    expect(get(session.body).text).toBe("Newer words, not saved yet");
    session.dispose();
  });

  it("opens next to the active post from the command", async () => {
    const c = await makeCtx({ seed: true });
    register(c);
    c.app.workspace.activeFile = c.app.vault.getFileByPath(BS);
    expect(c.ctx.composer.composeActiveNote(true)).toBe(true);
    c.ctx.composer.composeActiveNote(false);
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType(VIEW_COMPOSER)).toHaveLength(1));
    const view = c.app.workspace.getLeavesOfType(VIEW_COMPOSER)[0]!.view as unknown as ComposerView;
    expect(view.getState()).toEqual({ path: BS });
    expect((view.editorLeaf as unknown as WorkspaceLeaf).file?.path).toBe(BS);
    c.app.workspace.activeFile = c.app.vault.getFileByPath("Social/Event X/Event X.md");
    expect(c.ctx.composer.composeActiveNote(true)).toBe(false);
  });
});
