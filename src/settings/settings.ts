import { normalizePath } from "obsidian";
import { isRecord } from "../model/frontmatter";
import { DEFAULT_TEMPLATES, zScheduleTemplate, type ScheduleTemplate } from "../planner/templates";
import { zChannel, zChannelGroup, zMinutes, zMinutesList } from "../model/schemas";
import type { Channel, ChannelGroup } from "../model/types";

export const SETTINGS_VERSION = 2;

export interface OsmmSettings {
  schemaVersion: typeof SETTINGS_VERSION;
  rootFolder: string;
  weekStartsOn: 0 | 1;
  defaultReminders: number[];
  defaultStaggerMinutes: number;
  channels: Channel[];
  channelGroups: ChannelGroup[];
  scheduleTemplates: ScheduleTemplate[];
}

export const DEFAULT_SETTINGS: OsmmSettings = {
  schemaVersion: SETTINGS_VERSION,
  rootFolder: "Social",
  weekStartsOn: 1,
  defaultReminders: [60, 10],
  defaultStaggerMinutes: 15,
  channels: [],
  channelGroups: [],
  scheduleTemplates: structuredClone(DEFAULT_TEMPLATES),
};

type RawSettings = Record<string, unknown>;

/** MIGRATIONS[n] upgrades data from schema n to n + 1. */
const MIGRATIONS: Record<number, (raw: RawSettings) => RawSettings> = {
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
  1: (raw) => ({ ...raw, schemaVersion: 2, scheduleTemplates: structuredClone(DEFAULT_TEMPLATES) }),
};

function sanitize(raw: RawSettings): OsmmSettings {
  const root = typeof raw.rootFolder === "string" && raw.rootFolder.trim() ? normalizePath(raw.rootFolder.trim()) : DEFAULT_SETTINGS.rootFolder;
  const reminders = zMinutesList.safeParse(raw.defaultReminders);
  const stagger = zMinutes.safeParse(raw.defaultStaggerMinutes);
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .map((c) => zChannel.safeParse(c))
    .flatMap((r) => (r.success ? [r.data] : []));
  const groups = (Array.isArray(raw.channelGroups) ? raw.channelGroups : [])
    .map((g) => zChannelGroup.safeParse(g))
    .flatMap((r) => (r.success ? [r.data] : []));
  const templates = (Array.isArray(raw.scheduleTemplates) ? raw.scheduleTemplates : [])
    .map((t) => zScheduleTemplate.safeParse(t))
    .flatMap((r) => (r.success ? [r.data] : []));
  return {
    schemaVersion: SETTINGS_VERSION,
    rootFolder: root === "/" ? DEFAULT_SETTINGS.rootFolder : root,
    weekStartsOn: raw.weekStartsOn === 0 ? 0 : 1,
    defaultReminders: reminders.success ? reminders.data : [...DEFAULT_SETTINGS.defaultReminders],
    defaultStaggerMinutes: stagger.success ? stagger.data : DEFAULT_SETTINGS.defaultStaggerMinutes,
    channels,
    channelGroups: groups,
    scheduleTemplates: templates,
  };
}

export function migrateSettings(raw: unknown): OsmmSettings {
  let data: RawSettings = isRecord(raw) ? { ...raw } : {};
  let version = typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
  if (version > SETTINGS_VERSION) {
    throw new Error(`Settings were saved by a newer version of the plugin (schema ${version}). Please update the plugin.`);
  }
  while (version < SETTINGS_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`No settings migration from schema ${version}`);
    data = migrate(data);
    version = Number(data.schemaVersion);
  }
  return sanitize(data);
}

/** "60, 10" → [60, 10]; "" → []; anything invalid → null. */
export function parseMinutesList(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const r = zMinutesList.safeParse(parts.map(Number));
  return r.success ? r.data : null;
}
