import { countChars } from "../model/body";
import { PLATFORM_META } from "../model/platforms";
import type { Channel, Issue } from "../model/types";
import { platformDef } from "./registry";
import { countFor, hashtags, postItems, postText } from "./text";
import { MB, type ComposeInput, type PlatformDef } from "./types";

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

export function titleChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const { limits } = def.capabilities;
  const title = input.variant.title?.trim() ?? "";
  if (!title) {
    return limits.titleRequired ? [{ level: "error", field: "title", code: "missing-title", message: `${label(def)} needs a title.` }] : [];
  }
  const n = countChars(title);
  if (limits.titleMax && n > limits.titleMax) {
    return [{ level: "error", field: "title", code: "title-too-long", message: `The title is ${fmt(n)}/${fmt(limits.titleMax)} characters.` }];
  }
  return [];
}

export function linkChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const { link } = def.capabilities.limits;
  const url = input.variant.url;
  if (link === "required" && !url) {
    return [{ level: "error", field: "url", code: "missing-url", message: `${label(def)} needs a link (url).` }];
  }
  if (link === "url-or-text" && !url && postItems(input.body, def).length === 0) {
    return [{ level: "error", field: "url", code: "missing-url", message: `${label(def)} needs a link (url) or text.` }];
  }
  if (link === "none" && url) {
    return [{ level: "warning", field: "url", code: "url-ignored", message: `${label(def)} doesn't use the url field; put the link in the text if you need it.` }];
  }
  return [];
}

export function captionChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const max = def.capabilities.limits.maxCharsWithMedia;
  if (!max || input.media.length === 0) return [];
  const n = countFor(postText(input.body, def), def);
  if (n <= max) return [];
  return [{ level: "error", field: "body", code: "caption-too-long", message: `With media, ${label(def)} allows ${fmt(max)} characters; the text is ${fmt(n)}.` }];
}

export function hashtagChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const max = def.capabilities.limits.maxHashtags;
  if (!max) return [];
  const n = hashtags(postText(input.body, def)).length;
  if (n <= max) return [];
  return [{ level: "error", field: "body", code: "too-many-hashtags", message: `${label(def)} allows at most ${max} hashtags; this post has ${n}.` }];
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

export function mediaChecks(input: ComposeInput, def: PlatformDef): Issue[] {
  const rules = def.capabilities.media;
  const issues = mediaCountChecks(input, def);
  if (rules.required && !input.media.some((m) => m.kind === "image")) {
    issues.push({ level: "error", field: "media", code: "media-required", message: `${label(def)} needs an image.` });
  }
  if (rules.maxCount === 0) return issues;
  for (const m of input.media) {
    const field = `media.${m.target}`;
    if (m.kind === "missing") {
      issues.push({ level: "error", field, code: "media-missing", message: `${m.target} was not found in the vault.` });
    } else if (m.kind === "video") {
      issues.push({ level: "error", field, code: "video-unsupported", message: `${m.target}: video isn't supported yet. Remove it or use an image.` });
    } else if (m.kind === "unsupported") {
      issues.push({ level: "error", field, code: "media-type", message: `${m.target}: use a PNG, JPG, WebP or GIF image.` });
    } else {
      if (m.bytes !== undefined && m.bytes > rules.maxBytes) {
        issues.push({ level: "error", field, code: "media-too-large", message: `${m.target} is ${mb(m.bytes)}; ${label(def)} accepts up to ${mb(rules.maxBytes)}.` });
      }
      if (rules.ratio && m.width && m.height) {
        const r = m.width / m.height;
        if (r < rules.ratio.min - 0.005 || r > rules.ratio.max + 0.005) {
          issues.push({
            level: "error",
            field,
            code: "media-ratio",
            message: `${m.target} is ${r.toFixed(2)}:1; ${label(def)} accepts ${rules.ratio.min.toFixed(2)}:1 to ${rules.ratio.max.toFixed(2)}:1.`,
          });
        }
      }
      if (!m.alt?.trim()) issues.push({ level: "warning", field, code: "missing-alt", message: `${m.target} has no alt text.` });
    }
  }
  return issues;
}

export function validateFor(input: ComposeInput, def: PlatformDef, channel?: Channel): Issue[] {
  return [
    ...titleChecks(input, def),
    ...textChecks(input, def, channel),
    ...captionChecks(input, def),
    ...hashtagChecks(input, def),
    ...linkChecks(input, def),
    ...mediaChecks(input, def),
    ...(def.validate?.(input, channel) ?? []),
  ];
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
  const { limits } = def.capabilities;
  const items = postItems(input.body, def);
  const limit = input.media.length > 0 && limits.maxCharsWithMedia ? limits.maxCharsWithMedia : limitFor(def, channel);
  const out: Counter[] =
    items.length > 1
      ? items.map((t, i) => ({ label: `Part ${i + 1}`, value: countFor(t, def), limit }))
      : [{ label: "Length", value: countFor(items[0] ?? "", def), limit }];
  if (limits.foldAt) out.push({ label: "Fold", value: countFor(items[0] ?? "", def), limit: limits.foldAt });
  if (limits.titleMax) out.push({ label: "Title", value: countChars(input.variant.title?.trim() ?? ""), limit: limits.titleMax });
  if (limits.maxHashtags) out.push({ label: "Hashtags", value: hashtags(items.join("\n\n")).length, limit: limits.maxHashtags });
  return out;
}
