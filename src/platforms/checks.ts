import { PLATFORM_META } from "../model/platforms";
import type { Channel, Issue } from "../model/types";
import { platformDef } from "./registry";
import { countFor, postItems } from "./text";
import type { ComposeInput, PlatformDef } from "./types";

export const fmt = (n: number): string => n.toLocaleString("en-US");
const label = (def: PlatformDef): string => PLATFORM_META[def.id].label;

export function limitFor(def: PlatformDef, channel?: Channel): number {
  return channel?.maxChars ?? def.capabilities.limits.maxChars;
}

/** Empty text and per-item length (thread items on thread platforms). */
export function textChecks(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  const { limits, media } = def.capabilities;
  const items = postItems(input.body, def);
  if (items.length === 0) {
    // Link submissions (HN, Reddit) can go without text; linkChecks (Task 4) covers them.
    if (limits.link === "required" || limits.link === "url-or-text") return [];
    return [{ level: media.required ? "warning" : "error", field: "body", code: "empty-body", message: "Write the post text first." }];
  }
  const limit = limitFor(def, channel);
  const many = items.length > 1;
  const issues: Issue[] = [];
  items.forEach((text, i) => {
    const n = countFor(text, def);
    if (n <= limit) return;
    issues.push({
      level: "error",
      field: many ? `body.${i + 1}` : "body",
      code: "too-long",
      message: many ? `Part ${i + 1} is ${fmt(n)}/${fmt(limit)} characters.` : `The text is ${fmt(n)}/${fmt(limit)} characters.`,
    });
  });
  return issues;
}

export function mediaCountChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const n = input.media.length;
  const { maxCount } = def.capabilities.media;
  if (n > 0 && maxCount === 0) {
    return [{ level: "warning", field: "media", code: "media-ignored", message: `${label(def)} doesn't show attached images; they won't be posted.` }];
  }
  if (n > maxCount) {
    return [{ level: "error", field: "media", code: "too-many-media", message: `${label(def)} allows at most ${maxCount} images; this post has ${n}.` }];
  }
  return [];
}

export function validateFor(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  return [...textChecks(input, def, channel), ...mediaCountChecks(input, def), ...(def.validate?.(input, channel) ?? [])];
}

/** Validate for every selected channel (limits can differ per channel); each issue is reported once, errors first. */
export function validateAll(input: ComposeInput, channels: readonly Channel[]): Issue[] {
  const def = platformDef(input.variant.platform);
  const runs = channels.length ? channels.map((c) => validateFor(input, def, c)) : [validateFor(input, def)];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of runs.flat()) {
    const key = `${issue.level}|${issue.field}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

export function blocking(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export interface Counter {
  label: string;
  value: number;
  limit: number;
}

export function counters(input: ComposeInput, def: PlatformDef, channel?: Channel): Counter[] {
  const items = postItems(input.body, def);
  const limit = limitFor(def, channel);
  if (items.length > 1) return items.map((t, i) => ({ label: `Part ${i + 1}`, value: countFor(t, def), limit }));
  return [{ label: "Length", value: countFor(items[0] ?? "", def), limit }];
}
