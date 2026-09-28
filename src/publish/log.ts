export interface AttemptEntry {
  at: number;
  path: string;
  channelId: string;
  result: "published" | "failed" | "retry" | "skipped" | "awaiting_you" | "overdue" | "check_needed";
  url?: string;
  error?: string;
}

/** Every publish attempt is recorded (spec §5.6). M3 (#27) appends to Social/_log.md; M2 keeps them in memory. */
export interface AttemptLog {
  append(entry: AttemptEntry): void | Promise<void>;
}

export class MemoryLog implements AttemptLog {
  readonly entries: AttemptEntry[] = [];

  append(entry: AttemptEntry): void {
    this.entries.push(entry);
  }
}
