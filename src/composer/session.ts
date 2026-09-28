import type { App, Editor, MarkdownFileInfo, MarkdownView } from "obsidian";
import { writable, type Readable, type Writable } from "svelte/store";
import type { SocialIndex } from "../index/socialIndex";
import { bodyOf } from "../model/body";

export interface ComposerSession {
  path: Writable<string | null>;
  body: Readable<string>;
  dispose(): void;
}

/**
 * The body the composer previews: read from the vault when the note changes, and taken from the
 * editor buffer (debounced) while the user types, so the preview follows keystrokes, not saves.
 */
export function composerSession(app: App, index: SocialIndex, debounceMs = 100): ComposerSession {
  const path = writable<string | null>(null);
  const body = writable("");
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;

  const load = async (): Promise<void> => {
    const mine = ++token;
    const file = current ? app.vault.getFileByPath(current) : null;
    const text = file ? bodyOf(await app.vault.cachedRead(file)) : "";
    if (mine === token) body.set(text);
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      token++; // a vault read still in flight must not overwrite what was just typed
      body.set(bodyOf(editor.getValue()));
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
