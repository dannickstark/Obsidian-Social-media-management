import { heldForReview, unreadableRow, type PostRow } from "../index/queries";
import { MINUTE } from "../model/dates";

export interface ReminderItem {
  /** Row key + due time + offset: one reminder, whatever the number of ticks. */
  key: string;
  path: string;
  channelId: string;
  at: number;
  minutes: number;
  title: string;
}

/** Reminders missed by more than this (Obsidian closed, laptop asleep) are not shown. */
export const REMINDER_WINDOW_MS = 5 * MINUTE;

export function fireTime(item: Pick<ReminderItem, "at" | "minutes">): number {
  return item.at - item.minutes * MINUTE;
}

/**
 * Reminders whose time falls in (from, to], for scheduled posts after `postAfter`. `offsets` gives the
 * minutes-before list for a row, or null for rows that post by themselves. Unreadable delivery entries are
 * frozen: they never remind (desktop or phone).
 */
export function reminderSlots(
  rows: readonly PostRow[],
  from: number,
  to: number,
  postAfter: number,
  offsets: (row: PostRow) => readonly number[] | null,
): ReminderItem[] {
  const out: ReminderItem[] = [];
  for (const row of rows) {
    if (!row.channelId || row.status !== "scheduled" || row.at === undefined || row.at <= postAfter || unreadableRow(row) || heldForReview(row.variant)) continue;
    for (const minutes of offsets(row) ?? []) {
      if (minutes <= 0) continue;
      const fireAt = row.at - minutes * MINUTE;
      if (fireAt <= from || fireAt > to) continue;
      out.push({ key: `${row.key}@${row.at}:${minutes}`, path: row.variant.path, channelId: row.channelId, at: row.at, minutes, title: row.variant.displayTitle });
    }
  }
  return out.sort((a, b) => fireTime(a) - fireTime(b) || a.key.localeCompare(b.key));
}

/** Desktop: reminders whose time fell between the previous tick and now, never older than 5 minutes. */
export function dueReminders(
  rows: readonly PostRow[],
  now: number,
  previous: number | null,
  offsets: (row: PostRow) => readonly number[] | null,
): ReminderItem[] {
  return reminderSlots(rows, Math.max(previous ?? Number.NEGATIVE_INFINITY, now - REMINDER_WINDOW_MS), now, now, offsets);
}
