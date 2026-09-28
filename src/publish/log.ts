export interface AttemptEntry {
  at: number;
  path: string;
  channelId: string;
  result: "published" | "failed" | "retry" | "skipped" | "awaiting_you" | "overdue" | "check_needed";
  url?: string;
  error?: string;
}

/** Every publish attempt is recorded (spec §5.6). The plugin appends to `<root>/_log.md` (VaultLog); tests use MemoryLog. */
export interface AttemptLog {
  append(entry: AttemptEntry): void | Promise<void>;
}

export class MemoryLog implements AttemptLog {
  readonly entries: AttemptEntry[] = [];

  append(entry: AttemptEntry): void {
    this.entries.push(entry);
  }
}
