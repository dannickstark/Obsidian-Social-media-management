import { App, stringifyYaml, type TFile } from "obsidian";

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
