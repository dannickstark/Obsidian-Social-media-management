import { App, stringifyYaml, type TFile } from "obsidian";
import type { IndexChange, SocialIndex } from "../src/index/socialIndex";

export function createApp(): App {
  return new App();
}

/** Wait for queued timers (the fake emits metadata events on the next macrotask). */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeNote(
  app: App,
  path: string,
  frontmatter: Record<string, unknown> | null,
  body = "",
): Promise<TFile> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  const content = frontmatter ? `---\n${stringifyYaml(frontmatter)}---\n${body}` : body;
  const existing = app.vault.getFileByPath(path);
  if (existing) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return app.vault.create(path, content);
}

export function nextChange(index: SocialIndex): Promise<IndexChange> {
  return new Promise((resolve) => {
    const off = index.onChange((change) => {
      off();
      resolve(change);
    });
  });
}

/**
 * Wait for the index to reach a state where `predicate()` is true.
 * Checks immediately, then again after every `index.onChange` event.
 * Rejects after `timeoutMs` if the predicate never becomes true.
 */
export async function indexed(index: SocialIndex, predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  if (predicate()) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`index did not reach expected state within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = index.onChange(() => {
      if (predicate()) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}
