import { PLATFORM_META, type Platform } from "../../model/platforms";
import type { FailureInfo, PublishedInfo } from "../../publish/orchestrator";
import { formatTime } from "../../ui/format";
import type { ReminderItem } from "../reminders";
import type { NtfyAction, NtfyMessage } from "./client";
import type { NtfyConfig } from "./config";

/** `obsidian://osmm-post?vault=…&path=…&channel=…[&step=3]` opens the assisted flow for one channel. */
export const POST_ACTION = "osmm-post";
export const SNOOZE_MINUTES = 10;

export interface ReminderContentDeps {
  vaultName(): string;
  variant(path: string): { platform: Platform; displayTitle: string } | undefined;
  channelName(channelId: string): string;
  /** The pre-filled compose page for the delivery (mobile deep link first), or null when there is none. */
  targetUrl(path: string, channelId: string): Promise<string | null>;
  /**
   * False once the server said it can't cancel pushes (Task 8 ruling): a booked push can then not be replaced
   * when the note changes, so tapping it goes through Obsidian (resolved at tap time) instead of a baked URL.
   * Default: true.
   */
  cancelSupported?(): boolean;
}

export function obsidianUri(action: string, params: Record<string, string>): string {
  return `obsidian://${action}?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;
}

export function postUri(vault: string, path: string, channelId: string, step?: 3): string {
  return obsidianUri(POST_ACTION, { vault, path, channel: channelId, ...(step ? { step: String(step) } : {}) });
}

export function openNoteUri(vault: string, path: string): string {
  return obsidianUri("open", { vault, file: path });
}

export function leadTime(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

const label = (v: { platform: Platform } | undefined) => (v ? PLATFORM_META[v.platform].label : "Post");

/**
 * Artboard 7 / #70. Tapping the push opens the pre-filled page; the buttons open the assisted flow in
 * Obsidian (which copies the text and opens the page), open the note, and snooze (the snoozed push links through Obsidian). An ntfy `http` action
 * runs on the phone without credentials, so with an access token the third button is Done instead
 * (the token must never travel inside a notification). Tags are prefixed so ntfy never turns them into
 * emoji (M3 P10).
 */
export async function reminderMessage(item: ReminderItem, deps: ReminderContentDeps, target: Pick<NtfyConfig, "server" | "topic" | "token">): Promise<NtfyMessage> {
  const v = deps.variant(item.path);
  const vault = deps.vaultName();
  const copyOpen = postUri(vault, item.path, item.channelId);
  const prefilled = (deps.cancelSupported?.() ?? true) ? await deps.targetUrl(item.path, item.channelId) : null;
  const base = {
    title: `In ${leadTime(item.minutes)} · ${label(v)}`,
    message: `${item.title}\n${deps.channelName(item.channelId)} · ${formatTime(item.at)}`,
    priority: (item.minutes <= 15 ? 4 : 3) as 3 | 4,
    tags: ["osmm", ...(v ? [`osmm-${v.platform}`] : [])],
    click: prefilled ?? copyOpen,
  };
  const actions: NtfyAction[] = [
    { action: "view", label: "Copy & open", url: copyOpen, clear: true },
    { action: "view", label: "Open note", url: openNoteUri(vault, item.path) },
  ];
  const third: NtfyAction = target.token
    ? { action: "view", label: "Done", url: postUri(vault, item.path, item.channelId, 3), clear: true }
    : {
        action: "http",
        label: `Snooze ${SNOOZE_MINUTES} min`,
        url: `${target.server}/`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A snoozed re-post is never in the booking ledger, so it can't be rebooked when the note changes:
        // it always links through Obsidian (resolved at tap time), never to a baked pre-filled URL.
        body: JSON.stringify({ topic: target.topic, ...base, click: copyOpen, actions, delay: `${SNOOZE_MINUTES}m` }),
        clear: true,
      };
  return { ...base, actions: [...actions, third] };
}

export function failureMessage(info: FailureInfo, deps: Omit<ReminderContentDeps, "targetUrl">): NtfyMessage {
  const v = deps.variant(info.path);
  const note = openNoteUri(deps.vaultName(), info.path);
  return {
    title: `Couldn't publish · ${label(v)}`,
    message: `${v?.displayTitle ?? info.path}\n${deps.channelName(info.channelId)}: ${info.error}`,
    priority: 4,
    tags: ["osmm", "osmm-failed"],
    click: note,
    actions: [{ action: "view", label: "Open note", url: note }],
  };
}

export function publishedMessage(info: PublishedInfo, deps: Omit<ReminderContentDeps, "targetUrl">): NtfyMessage {
  const v = deps.variant(info.path);
  return {
    title: `Posted · ${label(v)}`,
    message: `${v?.displayTitle ?? info.path}\n${deps.channelName(info.channelId)}`,
    priority: 2,
    tags: ["osmm", "osmm-published"],
    click: info.url ?? openNoteUri(deps.vaultName(), info.path),
  };
}
