import type { PostRow } from "../index/queries";
import { startOfLocalDay } from "../model/dates";
import { dayKey, groupByDay } from "./calendar";

export interface AgendaDay {
  key: string;
  date: number;
  rows: PostRow[];
  isToday: boolean;
}

/** Phone agenda (#27): the days of [from, to) that have posts, in order, plus today when it is in the range. */
export function agendaDays(rows: readonly PostRow[], from: number, to: number, now: number): AgendaDay[] {
  const byDay = groupByDay(rows.filter((r) => r.at !== undefined && r.at >= from && r.at < to));
  const today = startOfLocalDay(now);
  const todayKey = dayKey(today);
  if (today >= from && today < to && !byDay.has(todayKey)) byDay.set(todayKey, []);
  return [...byDay.entries()]
    .map(([key, list]) => ({ key, date: list[0]?.at !== undefined ? startOfLocalDay(list[0].at) : today, rows: list, isToday: key === todayKey }))
    .sort((a, b) => a.date - b.date);
}
