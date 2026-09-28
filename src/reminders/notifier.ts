import { Notice } from "obsidian";
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
  setTimer?(fn: () => void, ms: number): void;
}

interface NoticeAction {
  label: string;
  run(): void;
}

const SNOOZE_MS = 10 * 60_000;

/** Desktop reminders (spec §4.4): an in-app notice with actions, plus a system notification when Obsidian is in the background. */
export class Notifier implements DeliveryNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  reminder(item: ReminderItem): void {
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
    const set = this.deps.setTimer ?? ((fn: () => void, t: number) => void setTimeout(fn, t));
    set(() => this.showReminder(item), ms);
  }

  private show(title: string, body: string, actions: NoticeAction[]): void {
    if (!this.deps.enabled()) return;
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
    buttons.forEach((button, i) =>
      button.addEventListener("click", () => {
        actions[i]!.run();
        notice.hide();
      }),
    );
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    if (Notification.permission === "granted") {
      const system = new Notification(title, { body });
      system.onclick = () => {
        window.focus();
        actions[0]?.run();
        notice.hide();
        system.close();
      };
    } else if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }
}
