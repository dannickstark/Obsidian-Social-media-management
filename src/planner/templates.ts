import { z } from "zod";
import type { IndexedVariant } from "../index/socialIndex";
import { DAY } from "../model/dates";
import { isPlatform, type Platform } from "../model/platforms";
import { zPlatform, zTimeOfDay } from "../model/schemas";
import { transition } from "../model/stateMachine";
import type { Delivery, DeliveryStatus, Variant } from "../model/types";
import type { VariantUpdate } from "../model/writer";
import { dayKey } from "./calendar";

export interface TemplateStep {
  offsetDays: number;
  time: string;
  platforms: Platform[];
  label: string;
}

export interface ScheduleTemplate {
  id: string;
  name: string;
  steps: TemplateStep[];
}

export const zScheduleTemplate = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1),
  steps: z.array(
    z.object({ offsetDays: z.number().int().min(-365).max(365), time: zTimeOfDay, platforms: z.array(zPlatform).min(1), label: z.string() }),
  ),
});

const LINE_RE = /^T([+-]?\d+)\s+(\d{2}:\d{2})\s+([a-z,]+)(?:\s+(.*))?$/;

export function parseTemplateLines(text: string): { steps: TemplateStep[]; errors: string[] } {
  const steps: TemplateStep[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .forEach((line, i) => {
      if (!line) return;
      const m = LINE_RE.exec(line);
      if (!m || !zTimeOfDay.safeParse(m[2]).success) {
        errors.push(`Line ${i + 1}: expected "T±days HH:mm platforms [label]"`);
        return;
      }
      const names = (m[3] ?? "").split(",").filter(Boolean);
      const unknown = names.find((n) => !isPlatform(n));
      if (unknown) {
        errors.push(`Line ${i + 1}: unknown platform ${unknown}`);
        return;
      }
      steps.push({ offsetDays: Number(m[1]), time: m[2]!, platforms: names as Platform[], label: (m[4] ?? "").trim() });
    });
  return { steps, errors };
}

const offsetLabel = (n: number) => (n === 0 ? "T0" : n > 0 ? `T+${n}` : `T${n}`);

export function formatTemplateLines(steps: readonly TemplateStep[]): string {
  return steps.map((s) => [offsetLabel(s.offsetDays), s.time, s.platforms.join(","), s.label].filter(Boolean).join(" ")).join("\n");
}

export const DEFAULT_TEMPLATES: ScheduleTemplate[] = [
  {
    id: "launch",
    name: "Launch",
    steps: parseTemplateLines(
      [
        "T-7 09:00 linkedin,x,mastodon,bluesky Announce",
        "T-6 18:00 instagram,facebook Visual push",
        "T-4 11:00 telegram,discord,whatsapp,reddit,hackernews,indiehackers Details",
        "T-2 09:00 wordpress Article",
        "T0 17:30 x,mastodon,bluesky Live",
        "T+1 09:00 linkedin Recap",
      ].join("\n"),
    ).steps,
  },
];

function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

export function relativeDayLabel(at: number, anchor: number): string {
  return offsetLabel(localDayIndex(at) - localDayIndex(anchor));
}

export interface TimelineStep {
  offset: number;
  label: string;
  date: number;
  platforms: Platform[];
  done: boolean;
}

export function campaignTimeline(anchor: number, variants: readonly IndexedVariant[]): TimelineStep[] {
  const byDay = new Map<string, TimelineStep>();
  for (const v of [...variants].filter((x) => x.scheduledAt !== undefined).sort((a, b) => a.scheduledAt! - b.scheduledAt!)) {
    const key = dayKey(v.scheduledAt!);
    const offset = localDayIndex(v.scheduledAt!) - localDayIndex(anchor);
    const step = byDay.get(key) ?? { offset, label: offsetLabel(offset), date: v.scheduledAt!, platforms: [], done: true };
    if (!step.platforms.includes(v.platform)) step.platforms.push(v.platform);
    step.done &&= v.status === "published" || v.status === "skipped";
    byDay.set(key, step);
  }
  return [...byDay.values()].sort((a, b) => a.offset - b.offset);
}

export interface TemplateProposal {
  variant: IndexedVariant;
  from?: number;
  to: number;
  label: string;
}

const LOCKED = new Set(["published", "partial", "skipped"]);

/** Posts a template must not move: done, partly done, or already handed to the platform. */
export function templateLocked(v: Pick<IndexedVariant, "status" | "deliveries">): boolean {
  return LOCKED.has(v.status) || Object.values(v.deliveries).some((d) => d.status === "handed_over" || d.status === "published");
}

/** Deliveries in flight: a template must not move their post either. */
const IN_FLIGHT = new Set<DeliveryStatus>(["publishing", "check_needed"]);
/** Deliveries whose explicit time is history, not a plan. */
const KEEPS_TIME = new Set<DeliveryStatus>(["published", "skipped", "handed_over"]);

export function templateMovable(v: Pick<Variant, "status" | "deliveries">): boolean {
  return !templateLocked(v) && !Object.values(v.deliveries).some((d) => IN_FLIGHT.has(d.status));
}

/**
 * A template move changes more than scheduled_at (parked M1 item): overdue deliveries become scheduled
 * again, and explicit per-channel times move with the post, or are dropped when it had no time yet.
 */
export function planTemplateMove(fresh: Variant, to: number): VariantUpdate | { refuse: string } {
  if (!templateMovable(fresh)) return { refuse: "locked" };
  const delta = fresh.scheduledAt === undefined ? null : to - fresh.scheduledAt;
  const deliveries: Record<string, Delivery> = {};
  for (const [id, d] of Object.entries(fresh.deliveries)) {
    let next: Delivery = d;
    if (d.at !== undefined && !KEEPS_TIME.has(d.status)) {
      next = { ...d };
      if (delta === null) delete next.at;
      else next.at = d.at + delta;
    }
    if (next.status === "overdue") next = transition(next, "scheduled");
    if (next !== d) deliveries[id] = next;
  }
  return { fields: { scheduledAt: to }, deliveries };
}

export function planTemplate(template: ScheduleTemplate, anchor: number, variants: readonly IndexedVariant[]): TemplateProposal[] {
  const pool = [...variants]
    .filter((v) => templateMovable(v))
    .sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity) || a.path.localeCompare(b.path));
  const used = new Set<string>();
  const a = new Date(anchor);
  const proposals: TemplateProposal[] = [];
  for (const step of [...template.steps].sort((x, y) => x.offsetDays - y.offsetDays)) {
    const [h, m] = step.time.split(":").map(Number) as [number, number];
    const to = new Date(a.getFullYear(), a.getMonth(), a.getDate() + step.offsetDays, h, m).getTime();
    for (const platform of step.platforms) {
      const v = pool.find((x) => x.platform === platform && !used.has(x.path));
      if (!v) continue;
      used.add(v.path);
      proposals.push({ variant: v, from: v.scheduledAt, to, label: offsetLabel(step.offsetDays) });
    }
  }
  return proposals;
}
