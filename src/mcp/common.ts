import { z } from "zod";
import type { IndexedVariant, SocialIndex } from "../index/socialIndex";
import { parseDateTime } from "../model/dates";
import { cyrb53 } from "../util/hash";
import type { McpToolDeps } from "./deps";

export const zPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('Vault path of the note as the list tools return it, e.g. "Social/Event X/Event X – LinkedIn.md"');

export const zWhen = z
  .string()
  .trim()
  .max(40)
  .refine((s) => parseDateTime(s) !== null, "Use an ISO 8601 date-time such as 2026-10-08T17:30:00+02:00")
  .transform((s) => parseDateTime(s) as number);

export const zHttpUrl = z.string().trim().max(2000).regex(/^https?:\/\/\S+$/i, "Use an http(s) link");

export const zKey = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .describe("Any unique string, e.g. a UUID. Calling again with the same key returns the first result instead of creating a second note.")
  .optional();

export const zChannelsArg = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .describe('Channel ids from list_channels, such as "li/acme-studio", or "group:<id>" for every channel of a group');

/** Accepts paths with or without ".md" and without a leading slash. */
export function normalizePathArg(path: string): string {
  const p = path.trim().replace(/^\/+/, "");
  return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
}

export function findPost(deps: Pick<McpToolDeps, "index">, path: string): IndexedVariant | undefined {
  return deps.index.getVariant(normalizePathArg(path));
}

export const noPost = (path: string): string => `No social post at "${path}". Use list_posts to find the path.`;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

/** Waits until the index shows a write (or the timeout passes), so the next read tool sees it. */
export function untilIndexed(index: SocialIndex, predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(predicate());
    }, timeoutMs);
    const off = index.onChange(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/** For IdempotencyCache: a kept outcome is still valid while the note it names (`data.path`) exists. */
export function noteStillExists(deps: Pick<McpToolDeps, "app">): (outcome: { data?: Record<string, unknown> }) => boolean {
  return (o) => typeof o.data?.path !== "string" || !!deps.app.vault.getFileByPath(o.data.path);
}

/** Every write by Claude is visible in Obsidian, with a way to look at it. */
export function claudeNotice(deps: Pick<McpToolDeps, "planner">, message: string, path: string): void {
  deps.planner.actionNotice(message, "Open", () => deps.planner.openNote(path));
}

/** A body without its trailing line breaks: a missing final newline is not a change. */
const normBody = (body: string): string => body.replace(/[\r\n]+$/, "");

export const sameBody = (a: string, b: string): boolean => normBody(a) === normBody(b);

/** What get_post returns and update_variant's base_body_hash is compared with (I3). */
export const bodyHash = (body: string): string => cyrb53(normBody(body)).toString(36);
