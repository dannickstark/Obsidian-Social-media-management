import type { DeviceSettings } from "./device";
import type { OsmmSettings, PublisherRecord } from "./settings";

export type PublisherState = { kind: "this" } | { kind: "other"; name: string; since: number } | { kind: "none" };

export function publisherState(publisher: PublisherRecord | null, deviceId: string): PublisherState {
  if (!publisher) return { kind: "none" };
  return publisher.deviceId === deviceId ? { kind: "this" } : { kind: "other", name: publisher.name, since: publisher.since };
}

export function publisherDescription(state: PublisherState): string {
  switch (state.kind) {
    case "this":
      return "This device posts scheduled items, moves late ones to the Overdue tray and books phone reminders. Keep Obsidian open here at posting times.";
    case "other":
      return `Publishing happens on ${state.name}. This device shows the plan and its own desktop reminders only.`;
    case "none":
      return "No device publishes yet, so scheduled posts are neither posted nor marked overdue. Choose one device, usually the computer that is on most.";
  }
}

export function takeoverMessage(name: string): string {
  return `Publishing happens on ${name}. Make this device the publisher instead? ${name} stops publishing as soon as this change reaches it through sync. Until then, avoid having both open at a post's time, or it could be posted twice. Wait until ${name} shows this change before editing publisher settings there — until it syncs, it can still write the old publisher back.`;
}

export interface PublisherDeps {
  device(): Pick<DeviceSettings, "deviceId" | "deviceName">;
  settings(): Pick<OsmmSettings, "publisher">;
  update(patch: { publisher: PublisherRecord | null }): Promise<void>;
  now(): number;
  /** Called after this device claimed the role (final review 3: point to the phone reminder setup). */
  claimed?(): void;
}

/** Spec §4.3: exactly one device publishes. The choice is synced; each device knows only its own id. */
export class PublisherService {
  constructor(private readonly deps: PublisherDeps) {}

  get deviceId(): string {
    return this.deps.device().deviceId;
  }

  state(): PublisherState {
    return publisherState(this.deps.settings().publisher, this.deviceId);
  }

  isPublisher(): boolean {
    return this.state().kind === "this";
  }

  async claim(): Promise<void> {
    const d = this.deps.device();
    await this.deps.update({ publisher: { deviceId: d.deviceId, name: d.deviceName, since: this.deps.now() } });
    this.deps.claimed?.();
  }

  /** Claims the role; asks first when another device holds it. False when the user declined. */
  async takeOver(confirm: (message: string) => Promise<boolean>): Promise<boolean> {
    const s = this.state();
    if (s.kind === "this") return true;
    if (s.kind === "other" && !(await confirm(takeoverMessage(s.name)))) return false;
    await this.claim();
    return true;
  }

  async release(): Promise<void> {
    if (this.isPublisher()) await this.deps.update({ publisher: null });
  }

  /** Keeps the synced name in step after this device is renamed. */
  async renamed(): Promise<void> {
    const current = this.deps.settings().publisher;
    const d = this.deps.device();
    if (current?.deviceId === d.deviceId && current.name !== d.deviceName) await this.deps.update({ publisher: { ...current, name: d.deviceName } });
  }
}
