import { get, writable, type Writable } from "svelte/store";
import { App } from "../fakes/obsidian";
import { buildSeed } from "../../scripts/seedData";
import { ChannelRegistry } from "../../src/channels/registry";
import { ComposerActions } from "../../src/composer/actions";
import { SocialIndex } from "../../src/index/socialIndex";
import { indexStore } from "../../src/index/stores";
import { NoteFactory } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { AdapterRegistry } from "../../src/platforms/registry";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { PlannerActions } from "../../src/ui/actions";
import type { OsmmContext } from "../../src/ui/context";
import { DEFAULT_VIEW_STATE } from "../../src/planner/viewState";
import { settle, writeNote } from "../helpers";

export const TEST_NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin

export interface TestCtx {
  app: App;
  ctx: OsmmContext;
  index: SocialIndex;
  writer: SafeWriter;
  settings: Writable<OsmmSettings>;
  now: Writable<number>;
}

export async function makeCtx(
  opts: {
    seed?: boolean;
    now?: number;
    notes?: Array<{ path: string; frontmatter: Record<string, unknown>; body?: string }>;
  } = {},
): Promise<TestCtx> {
  const app = new App();
  const now = opts.now ?? TEST_NOW;
  const seed = buildSeed(now);
  const notes = [...(opts.seed ? seed.notes : []), ...(opts.notes ?? [])];
  for (const n of notes) await writeNote(app as never, n.path, n.frontmatter, n.body ?? "");
  await settle();

  const settings = writable(migrateSettings(seed.settings));
  const channels = new ChannelRegistry({
    read: () => get(settings),
    write: async (next) => settings.update((s) => ({ ...s, ...next })),
  });
  const writer = new SafeWriter(app as never);
  const factory = new NoteFactory(app as never, writer, { rootFolder: () => get(settings).rootFolder });
  const index = new SocialIndex(app as never, 0);
  await index.build();
  index.start();
  const nowStore = writable(now);
  const actions = new PlannerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    settings: () => get(settings),
    now: () => get(nowStore),
  });
  const composer = new ComposerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    planner: actions,
    adapters: new AdapterRegistry(),
    settings: () => get(settings),
    now: () => get(nowStore),
  });
  const ctx: OsmmContext = {
    app: app as never,
    settings,
    snapshot: indexStore(index),
    now: nowStore,
    viewState: writable(structuredClone(DEFAULT_VIEW_STATE)),
    channels,
    actions,
    composer,
  };
  actions.context = ctx;
  return { app, ctx, index, writer, settings, now: nowStore };
}
