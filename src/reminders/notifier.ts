import { Notice, Platform } from "obsidian";
import type { DeliveryNotifier } from "../publish/actions";
import type { FailureInfo } from "../publish/orchestrator";
import type { NotifiedLedger } from "./ledger";
import type { ReminderItem } from "./reminders";

export interface NotifierDeps {
  ledger: NotifiedLedger;
  /** The device-local "Desktop notifications on this device" setting. */
  enabled(): boolean;
  channelName(channelId: string): string;
  noteTitle(path: string): string;
  openAssisted(path: string, channelIds: string[]): void;
  openComposer(path: string): void;
  snoozeMs?: number;
  /** Returns a handle that `clearTimer` accepts (window timers by default). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface NoticeAction {
  label: string;
  run(): void;
}

const SNOOZE_MS = 10 * 60_000;

/** Desktop reminders (spec §4.4): an in-app notice with actions, plus a system notification when Obsidian is in the background. */
export class Notifier implements DeliveryNotifier {
  private unloaded = false;
  private readonly timers = new Set<unknown>();
  private readonly notices = new Set<Notice>();
  private readonly systems = new Set<Notification>();

  constructor(private readonly deps: NotifierDeps) {}

  /** Plugin unload: cancel snoozes, hide persistent notices, close system notifications; later clicks do nothing. */
  dispose(): void {
    this.unloaded = true;
    const clear = this.deps.clearTimer ?? ((h: unknown) => window.clearTimeout(h as number));
    for (const h of this.timers) clear(h);
    this.timers.clear();
    for (const n of this.notices) n.hide();
    this.notices.clear();
    for (const n of this.systems) n.close();
    this.systems.clear();
  }

  reminder(item: ReminderItem): void {
    if (!this.deps.enabled()) return;
    if (!this.deps.ledger.add(item.key)) return;
    this.showReminder(item);
  }

  due(path: string, channelId: string): void {
    const channel = this.deps.channelName(channelId);
    this.show(`Time to post: ${this.deps.noteTitle(path)}`, `${channel} is waiting for you.`, [
      { label: "Open & post", run: () => this.deps.openAssisted(path, [channelId]) },
    ]);
  }

  failed(info: FailureInfo): void {
    this.show(`Couldn't publish: ${this.deps.noteTitle(info.path)}`, `${this.deps.channelName(info.channelId)}: ${info.error}`, [
      { label: "Fix", run: () => this.deps.openComposer(info.path) },
    ]);
  }

  private showReminder(item: ReminderItem): void {
    const snoozeMs = this.deps.snoozeMs ?? SNOOZE_MS;
    this.show(`In ${item.minutes} min: ${item.title}`, `Post to ${this.deps.channelName(item.channelId)}.`, [
      { label: "Open & post", run: () => this.deps.openAssisted(item.path, [item.channelId]) },
      { label: `Snooze ${Math.round(snoozeMs / 60_000)} min`, run: () => this.snooze(item, snoozeMs) },
    ]);
  }

  private snooze(item: ReminderItem, ms: number): void {
    if (this.unloaded) return;
    const set = this.deps.setTimer ?? ((fn: () => void, t: number) => window.setTimeout(fn, t));
    const handle = set(() => {
      this.timers.delete(handle);
      this.showReminder(item);
    }, ms);
    this.timers.add(handle);
  }

  private show(title: string, body: string, actions: NoticeAction[]): void {
    if (this.unloaded || !this.deps.enabled()) return;
    const fragment = document.createDocumentFragment();
    const text = document.createElement("div");
    text.textContent = `${title} · ${body}`;
    const buttons = actions.map((a) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = a.label;
      return button;
    });
    fragment.append(text, ...buttons);
    const notice = new Notice(fragment, 0);
    this.notices.add(notice);
    const hide = () => {
      notice.hide();
      this.notices.delete(notice);
    };
    buttons.forEach((button, i) =>
      button.addEventListener("click", () => {
        if (this.unloaded) return;
        actions[i]!.run();
        hide();
      }),
    );
    // System notifications only in the desktop app; phones get the in-app notice (and ntfy pushes, M3).
    if (!Platform.isDesktopApp || typeof Notification === "undefined" || document.hasFocus()) return;
    if (Notification.permission === "granted") {
      const system = new Notification(title, { body });
      this.systems.add(system);
      system.onclick = () => {
        if (this.unloaded) return;
        window.focus();
        actions[0]?.run();
        hide();
        system.close();
        this.systems.delete(system);
      };
    } else if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }
}
