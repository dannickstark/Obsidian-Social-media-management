import { MarkdownView, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { writable, type Readable, type Writable } from "svelte/store";
import type { SocialIndex } from "../index/socialIndex";
import { bodyOf } from "../model/body";

/** A note body, tagged with the path it was read from so a view never mixes one note's text with another note. */
export interface SessionBody {
  path: string | null;
  text: string;
}

export interface ComposerSession {
  path: Writable<string | null>;
  body: Readable<SessionBody>;
  dispose(): void;
}

/** An open Markdown view showing `path`, if any: its editor buffer can be newer than the file on disk. */
export function openMarkdownView(app: App, path: string): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) return view;
  }
  return null;
}

/**
 * The body the composer previews: read when the note changes (from an open editor on that note if there is
 * one, otherwise from the vault), and taken from the editor buffer (debounced) while the user types, so the
 * preview follows keystrokes, not saves.
 */
export function composerSession(app: App, index: SocialIndex, debounceMs = 100): ComposerSession {
  const path = writable<string | null>(null);
  const body = writable<SessionBody>({ path: null, text: "" });
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;

  const load = async (): Promise<void> => {
    const mine = ++token;
    const p = current;
    const editor = p ? (openMarkdownView(app, p)?.editor ?? null) : null;
    let text = "";
    if (editor) text = bodyOf(editor.getValue());
    else {
      const file = p ? app.vault.getFileByPath(p) : null;
      text = file ? bodyOf(await app.vault.cachedRead(file)) : "";
    }
    if (mine === token) body.set({ path: p, text });
  };

  const unsubscribe = path.subscribe((p) => {
    current = p;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void load();
  });

  const ref = app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
    if (!current || info.file?.path !== current) return;
    const p = current;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      token++; // a vault read still in flight must not overwrite what was just typed
      body.set({ path: p, text: bodyOf(editor.getValue()) });
    }, debounceMs);
  });

  const offIndex = index.onChange((change) => {
    if (current && timer === null && change.changed.includes(current)) void load();
  });

  return {
    path,
    body,
    dispose() {
      unsubscribe();
      app.workspace.offref(ref);
      offIndex();
      if (timer) clearTimeout(timer);
    },
  };
}
