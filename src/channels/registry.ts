import { PLATFORM_META, type Platform } from "../model/platforms";
import { zChannel, zChannelGroup, zodIssues } from "../model/schemas";
import type { Channel, ChannelGroup, Issue, Variant } from "../model/types";

export interface ChannelState {
  channels: Channel[];
  channelGroups: ChannelGroup[];
}

export interface ChannelStore {
  read(): ChannelState;
  write(next: ChannelState): Promise<void>;
}

export type UpsertResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export const GROUP_PREFIX = "group:";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "channel"
  );
}

export class ChannelRegistry {
  constructor(private readonly store: ChannelStore) {}

  list(): Channel[] {
    return this.store.read().channels;
  }

  byPlatform(platform: Platform): Channel[] {
    return this.list().filter((c) => c.platform === platform);
  }

  get(id: string): Channel | undefined {
    return this.list().find((c) => c.id === id);
  }

  groups(): ChannelGroup[] {
    return this.store.read().channelGroups;
  }

  group(id: string): ChannelGroup | undefined {
    return this.groups().find((g) => g.id === id);
  }

  async upsertChannel(input: unknown): Promise<UpsertResult<Channel>> {
    const r = zChannel.safeParse(input);
    if (!r.success) return { ok: false, issues: zodIssues(r.error) };
    const { channels, channelGroups } = this.store.read();
    const exists = channels.some((c) => c.id === r.data.id);
    const next = exists ? channels.map((c) => (c.id === r.data.id ? r.data : c)) : [...channels, r.data];
    await this.store.write({ channels: next, channelGroups });
    return { ok: true, value: r.data };
  }

  async removeChannel(id: string): Promise<void> {
    const { channels, channelGroups } = this.store.read();
    await this.store.write({
      channels: channels.filter((c) => c.id !== id),
      channelGroups: channelGroups.map((g) => ({ ...g, channelIds: g.channelIds.filter((c) => c !== id) })),
    });
  }

  async upsertGroup(input: unknown): Promise<UpsertResult<ChannelGroup>> {
    const r = zChannelGroup.safeParse(input);
    if (!r.success) return { ok: false, issues: zodIssues(r.error) };
    const unknown = r.data.channelIds.filter((id) => !this.get(id));
    if (unknown.length) {
      return { ok: false, issues: unknown.map((id) => ({ level: "error", field: "channelIds", message: `Unknown channel ${id}` })) };
    }
    const { channels, channelGroups } = this.store.read();
    const exists = channelGroups.some((g) => g.id === r.data.id);
    const next = exists ? channelGroups.map((g) => (g.id === r.data.id ? r.data : g)) : [...channelGroups, r.data];
    await this.store.write({ channels, channelGroups: next });
    return { ok: true, value: r.data };
  }

  async removeGroup(id: string): Promise<void> {
    const { channels, channelGroups } = this.store.read();
    await this.store.write({ channels, channelGroups: channelGroups.filter((g) => g.id !== id) });
  }

  /** Resolve channel ids and `group:<id>` references to known channel ids, in order, without duplicates. */
  expand(ids: readonly string[]): string[] {
    const out: string[] = [];
    const push = (id: string) => {
      if (this.get(id) && !out.includes(id)) out.push(id);
    };
    for (const id of ids) {
      if (id.startsWith(GROUP_PREFIX)) this.group(id.slice(GROUP_PREFIX.length))?.channelIds.forEach(push);
      else push(id);
    }
    return out;
  }

  usage(id: string, variants: readonly Pick<Variant, "path" | "channels" | "deliveries">[]): string[] {
    return variants.filter((v) => v.channels.includes(id) || id in v.deliveries).map((v) => v.path);
  }

  suggestId(platform: Platform, name: string): string {
    const base = `${PLATFORM_META[platform].prefix}/${slugify(name)}`;
    let candidate = base;
    for (let n = 2; this.get(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
  }
}
