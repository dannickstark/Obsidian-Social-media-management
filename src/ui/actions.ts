import { Notice, type App } from "obsidian";
import type { ChannelRegistry } from "../channels/registry";
import { expandRows, type PostRow } from "../index/queries";
import type { SocialIndex } from "../index/socialIndex";
import type { NoteFactory } from "../model/factory";
import { PLATFORM_META } from "../model/platforms";
import type { SafeWriter } from "../model/writer";
import { planReschedule, type RescheduleTarget } from "../planner/reschedule";
import { STATUS_LABEL } from "../planner/status";
import type { OsmmSettings } from "../settings/settings";
import { confirmDialog } from "./dialogs";
import { formatShortDate, formatTime } from "./format";

export const VIEW_PLANNER = "osmm-planner";
export const VIEW_SIDEBAR = "osmm-sidebar";
export const ROW_MIME = "text/x-osmm-row";

export interface ActionDeps {
  app: App;
  writer: SafeWriter;
  factory: NoteFactory;
  channels: ChannelRegistry;
  index: SocialIndex;
  settings(): OsmmSettings;
  now(): number;
}

/** Every UI side effect goes through this class; components stay declarative. */
export class PlannerActions {
  private readonly hoverParent = { hoverPopover: null };
  private rowsCache: { revision: number; stagger: number; rows: PostRow[] } | undefined;

  constructor(protected readonly deps: ActionDeps) {}

  openNote(path: string, newLeaf = false): void {
    void this.deps.app.workspace.openLinkText(path, "", newLeaf);
  }

  hoverPreview(event: MouseEvent, path: string): void {
    this.deps.app.workspace.trigger("hover-link", {
      event,
      source: VIEW_PLANNER,
      hoverParent: this.hoverParent,
      targetEl: event.currentTarget,
      linktext: path,
    });
  }

  /**
   * Cached per index revision and stagger setting so a row object handed to the UI (e.g. from a
   * list render) stays `===` across repeated calls until the index or the stagger default
   * actually changes.
   */
  rows(): PostRow[] {
    const revision = this.deps.index.revision;
    const stagger = this.deps.settings().defaultStaggerMinutes;
    if (!this.rowsCache || this.rowsCache.revision !== revision || this.rowsCache.stagger !== stagger) {
      this.rowsCache = { revision, stagger, rows: expandRows(this.deps.index.variants(), stagger) };
    }
    return this.rowsCache.rows;
  }

  rowByKey(key: string): PostRow | undefined {
    return this.rows().find((r) => r.key === key);
  }

  rowLabel(row: PostRow): string {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const parts = [PLATFORM_META[row.variant.platform].label];
    if (channel) parts.push(channel.name);
    parts.push(row.at === undefined ? "unscheduled" : `${formatShortDate(row.at)} ${formatTime(row.at)}`);
    parts.push(STATUS_LABEL[row.status]);
    return `${parts.join(" · ")} — ${row.variant.displayTitle}`;
  }

  /** Overridable in tests. */
  confirm(message: string, cta?: string): Promise<boolean> {
    return confirmDialog(this.deps.app, message, cta);
  }

  undoNotice(message: string, undo: () => unknown): void {
    const fragment = document.createDocumentFragment();
    const text = document.createElement("span");
    text.textContent = `${message} `;
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = "Undo";
    fragment.append(text, link);
    const notice = new Notice(fragment, 8000);
    link.addEventListener("click", () => {
      void undo();
      notice.hide();
    });
  }

  async reschedule(row: PostRow, target: RescheduleTarget): Promise<boolean> {
    const channel = row.channelId ? this.deps.channels.get(row.channelId) : undefined;
    const plan = planReschedule(row, target, channel?.defaultTime ?? "09:00");
    if (!plan.ok) {
      new Notice(plan.reason);
      return false;
    }
    if (plan.needsConfirm) {
      const go = await this.confirm(
        "This post was already handed over to the platform. Moving it here won't change it on the platform until you push an update. Move anyway?",
        "Move",
      );
      if (!go) return false;
    }
    const file = row.variant.file;
    await this.deps.writer.patchVariant(file, plan.patch);
    this.undoNotice(`Moved to ${formatShortDate(plan.newAt)} ${formatTime(plan.newAt)}.`, () =>
      this.deps.writer.patchVariant(file, plan.previous),
    );
    return true;
  }

  dragStart(event: DragEvent, row: PostRow): void {
    event.dataTransfer?.setData(ROW_MIME, row.key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  private dropped(event: DragEvent): PostRow | undefined {
    event.preventDefault();
    const key = event.dataTransfer?.getData(ROW_MIME);
    return key ? this.rowByKey(key) : undefined;
  }

  dropOnDay(event: DragEvent, day: number): void {
    const row = this.dropped(event);
    if (row) void this.reschedule(row, { day });
  }

  dropOnSlot(event: DragEvent, day: number, minutes: number): void {
    const row = this.dropped(event);
    if (!row) return;
    const d = new Date(day);
    void this.reschedule(row, { at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime() });
  }
}
