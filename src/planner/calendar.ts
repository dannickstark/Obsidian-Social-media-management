import type { IndexedCampaign } from "../index/socialIndex";
import type { PostRow } from "../index/queries";

export interface DayCell {
  key: string;
  /** Local midnight, epoch ms. */
  date: number;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cell(y: number, m: number, d: number, month: number, todayKey: string): DayCell {
  const date = new Date(y, m, d);
  const ms = date.getTime();
  const key = dayKey(ms);
  return { key, date: ms, day: date.getDate(), inMonth: date.getMonth() === month, isToday: key === todayKey };
}

function firstVisibleDay(year: number, month: number, weekStartsOn: 0 | 1): Date {
  const offset = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  return new Date(year, month, 1 - offset);
}

export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1, today: number): DayCell[][] {
  const start = firstVisibleDay(year, month, weekStartsOn);
  const offset = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  const weeks = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7);
  const todayKey = dayKey(today);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) =>
      cell(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i, month, todayKey),
    ),
  );
}

export function monthRange(year: number, month: number, weekStartsOn: 0 | 1): { from: number; to: number } {
  const weeks = monthGrid(year, month, weekStartsOn, 0);
  const last = weeks[weeks.length - 1]![6]!;
  const end = new Date(last.date);
  return { from: weeks[0]![0]!.date, to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime() };
}

export function weekdayLabels(weekStartsOn: 0 | 1, locale?: string): string[] {
  // 4 Jan 2026 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2026, 0, 4 + weekStartsOn + i).toLocaleDateString(locale, { weekday: "short" }),
  );
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function groupByDay(rows: readonly PostRow[]): Map<string, PostRow[]> {
  const map = new Map<string, PostRow[]>();
  for (const row of [...rows].filter((r) => r.at !== undefined).sort((a, b) => a.at! - b.at!)) {
    const key = dayKey(row.at!);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function anchorsByDay(campaigns: readonly IndexedCampaign[]): Map<string, IndexedCampaign[]> {
  const map = new Map<string, IndexedCampaign[]>();
  for (const c of campaigns) {
    if (c.anchorDate === undefined || c.status === "archived") continue;
    const key = dayKey(c.anchorDate);
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return map;
}
