import { get, writable, type Writable } from "svelte/store";
import { App } from "../fakes/obsidian";
import { buildSeed } from "../../scripts/seedData";
import { ChannelRegistry } from "../../src/channels/registry";
import { ComposerActions } from "../../src/composer/actions";
import { SocialIndex } from "../../src/index/socialIndex";
import { indexStore } from "../../src/index/stores";
import { NoteFactory } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { DEFAULT_VIEW_STATE } from "../../src/planner/viewState";
import { AdapterRegistry } from "../../src/platforms/registry";
import { PublishActions } from "../../src/publish/actions";
import { ClipboardService } from "../../src/publish/clipboard";
import { MemoryLog } from "../../src/publish/log";
import { Secrets } from "../../src/secrets/secrets";
import type { DeviceSettings } from "../../src/settings/device";
import { PublisherService } from "../../src/settings/publisher";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { PlannerActions } from "../../src/ui/actions";
import type { OsmmContext } from "../../src/ui/context";
import { settle, writeNote } from "../helpers";

export const TEST_NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin

export interface TestCtx {
  app: App;
  ctx: OsmmContext;
  index: SocialIndex;
  writer: SafeWriter;
  settings: Writable<OsmmSettings>;
  now: Writable<number>;
  adapters: AdapterRegistry;
  log: MemoryLog;
  publisher: PublisherService;
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
  const clock = () => get(nowStore);
  const actions = new PlannerActions({ app: app as never, writer, factory, channels, index, settings: () => get(settings), now: clock });
  const adapters = new AdapterRegistry();
  const composer = new ComposerActions({
    app: app as never,
    writer,
    factory,
    channels,
    index,
    planner: actions,
    adapters,
    settings: () => get(settings),
    now: clock,
  });
  const log = new MemoryLog();
  const publish = new PublishActions({
    app: app as never,
    writer,
    index,
    channels,
    planner: actions,
    composer,
    adapters,
    clipboard: new ClipboardService(app as never),
    log,
    secrets: new Secrets(app as never),
    delay: async () => undefined,
    settings: () => get(settings),
    now: clock,
  });
  const device: DeviceSettings = { deviceId: "test-device", deviceName: "Test laptop", notifications: true, ntfy: { enabled: false, server: "https://ntfy.sh", results: false } };
  const publisher = new PublisherService({
    device: () => device,
    settings: () => get(settings),
    update: async (patch) => settings.update((s) => ({ ...s, ...patch })),
    now: clock,
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
    publish,
    publisher,
  };
  actions.context = ctx;
  publish.context = ctx;
  return { app, ctx, index, writer, settings, now: nowStore, adapters, log, publisher };
}
