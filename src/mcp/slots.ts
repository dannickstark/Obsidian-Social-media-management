import type { PostRow } from "../index/queries";
import { addLocalDays, MINUTE, startOfLocalDay } from "../model/dates";

export interface SlotWindow {
  /** 0 = Sunday … 6 = Saturday; every day when left out. */
  days?: readonly number[];
  /** Local HH:mm, inclusive. */
  start: string;
  end: string;
}

export interface SlotQuery {
  from: number;
  to: number;
  now: number;
  minSpacingMinutes: number;
  stepMinutes: number;
  perChannel: number;
  windows?: readonly SlotWindow[];
  /** The channel's usual posting time (HH:mm); slots closer to it rank higher. */
  preferredTime?: string;
}

export interface FreeSlot {
  at: number;
  score: number;
  /** Minutes to the nearest existing post on the channel; null when it has none. */
  nearestMinutes: number | null;
}

export const DEFAULT_WINDOW: SlotWindow = { start: "09:00", end: "18:00" };
export const MAX_RANGE_DAYS = 62;

export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Times the channel is already taken: every row with a time except skipped ones (drafts' proposed times count). */
export function busyTimes(rows: readonly PostRow[], channelId: string): number[] {
  return rows
    .filter((r) => r.channelId === channelId && r.at !== undefined && r.status !== "skipped")
    .map((r) => r.at as number)
    .sort((a, b) => a - b);
}

function nearest(busy: readonly number[], at: number): number | null {
  if (!busy.length) return null;
  return Math.round(Math.min(...busy.map((b) => Math.abs(b - at))) / MINUTE);
}

/** Ranked free slots for one channel (#76). Pure: the same input always gives the same output. */
export function findFreeSlots(busy: readonly number[], q: SlotQuery): FreeSlot[] {
  const windows = q.windows?.length ? q.windows : [DEFAULT_WINDOW];
  const spacing = q.minSpacingMinutes * MINUTE;
  const scores = new Map<number, number>();
  for (let day = startOfLocalDay(q.from); day < q.to; day = addLocalDays(day, 1)) {
    const d = new Date(day);
    for (const w of windows) {
      if (w.days && !w.days.includes(d.getDay())) continue;
      const start = minutesOfDay(w.start);
      const end = minutesOfDay(w.end);
      const wanted = q.preferredTime ? minutesOfDay(q.preferredTime) : -1;
      const preferred = wanted >= start && wanted <= end ? wanted : start;
      for (let m = start; m <= end; m += q.stepMinutes) {
        // Built from the calendar date, so 09:00 stays 09:00 across a DST change.
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m).getTime();
        if (at < q.from || at >= q.to || at <= q.now) continue;
        if (busy.some((b) => Math.abs(b - at) < spacing)) continue;
        const score = Math.max(0, 100 - Math.round(Math.abs(m - preferred) / 6));
        if ((scores.get(at) ?? -1) < score) scores.set(at, score);
      }
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const picked: Array<[number, number]> = [];
  for (const candidate of ranked) {
    if (picked.length >= q.perChannel) break;
    if (picked.every(([t]) => Math.abs(t - candidate[0]) >= spacing)) picked.push(candidate);
  }
  return picked.map(([t, score]) => ({ at: t, score, nearestMinutes: nearest(busy, t) }));
}
