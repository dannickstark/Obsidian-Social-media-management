import { normalizePath, type App, type TFile } from "obsidian";
import { formatDateTime } from "../model/dates";
import type { AttemptEntry, AttemptLog } from "./log";

export interface VaultLogDeps {
  app: App;
  rootFolder(): string;
  /** Removes every known secret value from a piece of text (spec §2.6). */
  redact(text: string): string;
  channelName(channelId: string): string;
  /** Reports a failed append (a Notice in the plugin); called once per failure streak. */
  warn(message: string): void;
}

export const LOG_HEADER =
  "# Publish log\n\nOne line per publish attempt, oldest first: time · channel · post · result · link or error. Written by Social Planner; earlier months move to the _log folder.\n\n";

const RESULT_LABEL: Readonly<Record<AttemptEntry["result"], string>> = {
  published: "published",
  failed: "failed",
  retry: "failed, will retry",
  skipped: "skipped",
  awaiting_you: "waiting for you",
  overdue: "overdue",
  check_needed: "check needed",
  updated: "updated on the platform",
  update_failed: "update failed",
  handed_over: "handed over to the platform",
  handover_failed: "hand-over failed, stays scheduled",
  cancelled: "taken off the platform's schedule",
};

/** First entry line of a log file: "- 2026-10-08T…". */
const ENTRY_MONTH_RE = /^- (\d{4}-\d{2})-\d{2}T/m;
const MAX_ERROR = 300;

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** One line stays one line: whitespace collapses, `[[`/`]]` go, and `|` can't open a table or alias. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\[\[|\]\]/g, "").replace(/\|/g, "/").trim();
}

export function formatLogLine(entry: AttemptEntry, channelName: string, redact: (text: string) => string): string {
  const clean = (text: string) => flat(redact(text));
  const channel = channelName && channelName !== entry.channelId ? `${clean(channelName)} (${clean(entry.channelId)})` : clean(entry.channelId);
  const parts = [formatDateTime(entry.at), channel, `[[${clean(entry.path.replace(/\.md$/, ""))}]]`, RESULT_LABEL[entry.result]];
  if (entry.url) parts.push(clean(entry.url));
  if (entry.error) parts.push(clean(entry.error).slice(0, MAX_ERROR));
  return `- ${parts.join(" · ")}`;
}

/**
 * Spec §5.6: every attempt is appended to `<root>/_log.md`. Appends run one after another (a promise
 * queue), so lines never interleave; the file is read-modify-written with `vault.process`, so the user's
 * own edits stay. The first entry of a newer month moves the file to `<root>/_log/YYYY-MM.md`.
 */
export class VaultLog implements AttemptLog {
  private queue: Promise<void> = Promise.resolve();
  private failing = false;

  constructor(private readonly deps: VaultLogDeps) {}

  get path(): string {
    return normalizePath(`${this.deps.rootFolder()}/_log.md`);
  }

  archivePath(month: string): string {
    return normalizePath(`${this.deps.rootFolder()}/_log/${month}.md`);
  }

  /** Never rejects: a failed write is reported through `warn` (the publish itself already happened). */
  append(entry: AttemptEntry): Promise<void> {
    const line = formatLogLine(entry, this.deps.channelName(entry.channelId), (t) => this.deps.redact(t));
    const month = monthKey(entry.at);
    this.queue = this.queue
      .then(() => this.write(line, month))
      .then(
        () => {
          this.failing = false;
        },
        (e: unknown) => {
          if (this.failing) return;
          this.failing = true;
          this.deps.warn(`Couldn't write to the publish log: ${this.deps.redact(e instanceof Error ? e.message : String(e))}`);
        },
      );
    return this.queue;
  }

  /** Resolves once every append queued so far is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  private async write(line: string, month: string): Promise<void> {
    const { vault } = this.deps.app;
    let file: TFile | null = vault.getFileByPath(this.path);
    if (file) {
      const first = ENTRY_MONTH_RE.exec(await vault.read(file))?.[1];
      if (first && first < month) {
        await this.archive(file, first);
        file = null;
      }
    }
    if (!file) {
      await this.ensureFolderOf(this.path);
      await vault.create(this.path, `${LOG_HEADER}${line}\n`);
      return;
    }
    await vault.process(file, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  private async archive(file: TFile, month: string): Promise<void> {
    const { vault } = this.deps.app;
    const target = this.archivePath(month);
    const existing = vault.getFileByPath(target);
    if (!existing) {
      await this.ensureFolderOf(target);
      await vault.rename(file, target);
      return;
    }
    const lines = (await vault.read(file))
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .join("\n");
    await vault.process(existing, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines}\n`);
    await this.deps.app.fileManager.trashFile(file);
  }

  private async ensureFolderOf(filePath: string): Promise<void> {
    const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (!dir || this.deps.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.deps.app.vault.createFolder(dir);
    } catch {
      // created by a concurrent write
    }
  }
}
