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

export const PX_PER_MINUTE = 0.8;

/**
 * Minute of the day for a drop at `clientY` on a day column whose top is at `rectTop`, rounded to
 * 15 minutes and clamped to 00:00–23:45 (so the bottom edge never rolls over to the next day).
 */
export function dropMinutes(clientY: number, rectTop: number): number {
  return Math.min(1425, Math.max(0, Math.round((clientY - rectTop) / PX_PER_MINUTE / 15) * 15));
}

export function weekCells(anchor: number, weekStartsOn: 0 | 1, today: number): DayCell[] {
  const d = new Date(anchor);
  const offset = (d.getDay() - weekStartsOn + 7) % 7;
  const todayKey = dayKey(today);
  return Array.from({ length: 7 }, (_, i) => {
    const c = cell(d.getFullYear(), d.getMonth(), d.getDate() - offset + i, -1, todayKey);
    return { ...c, inMonth: true };
  });
}

export function weekRange(anchor: number, weekStartsOn: 0 | 1): { from: number; to: number } {
  const cells = weekCells(anchor, weekStartsOn, 0);
  const first = new Date(cells[0]!.date);
  return { from: first.getTime(), to: new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7).getTime() };
}

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export interface PlacedRow {
  row: PostRow;
  /** Minutes since local midnight. */
  top: number;
  lane: number;
  lanes: number;
}

/** Greedy lane assignment: posts closer than `blockMinutes` share a cluster and get side-by-side lanes. */
export function layoutDay(rows: readonly PostRow[], blockMinutes = 30): PlacedRow[] {
  const sorted = [...rows].filter((r) => r.at !== undefined).sort((a, b) => a.at! - b.at!);
  const placed: PlacedRow[] = [];
  let cluster: PlacedRow[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const row of sorted) {
    const top = minutesOfDay(row.at!);
    if (top >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= top);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(top + blockMinutes);
    } else laneEnds[lane] = top + blockMinutes;
    clusterEnd = Math.max(clusterEnd, top + blockMinutes);
    const p: PlacedRow = { row, top, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
  }
  close();
  return placed;
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
