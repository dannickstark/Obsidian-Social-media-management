import type { ChannelRegistry } from "../channels/registry";
import type { PostRow } from "../index/queries";
import { effectiveMethod, type AdapterRegistry } from "../platforms/registry";
import type { OsmmSettings } from "../settings/settings";
import type { Notifier } from "./notifier";
import { dueReminders, type ReminderItem } from "./reminders";

export interface ReminderServiceDeps {
  rows(): PostRow[];
  channels: ChannelRegistry;
  adapters: AdapterRegistry;
  settings(): OsmmSettings;
  notifier: Pick<Notifier, "reminder">;
}

/** Turns reminder offsets into notifications; runs on every tick on every device (spec §4.3). */
export class ReminderService {
  constructor(private readonly deps: ReminderServiceDeps) {}

  /** Minutes-before list for a row; null when the channel posts by itself (API or native). */
  offsets(row: PostRow): readonly number[] | null {
    if (!row.channelId) return null;
    const channel = this.deps.channels.get(row.channelId);
    if (effectiveMethod(row.variant.mode, channel, this.deps.adapters.get(row.variant.platform)) !== "assisted") return null;
    return row.variant.reminders ?? channel?.defaultReminders ?? this.deps.settings().defaultReminders;
  }

  tick(now: number, previous: number | null): ReminderItem[] {
    const items = dueReminders(this.deps.rows(), now, previous, (row) => this.offsets(row));
    for (const item of items) this.deps.notifier.reminder(item);
    return items;
  }
}
