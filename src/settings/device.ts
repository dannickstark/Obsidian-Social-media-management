import type { App } from "obsidian";
import { isRecord } from "../model/frontmatter";

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
}

const KEY = "osmm-device";

export function loadDeviceSettings(app: App): DeviceSettings {
  const raw: unknown = app.loadLocalStorage(KEY);
  if (isRecord(raw) && typeof raw.deviceId === "string") return { deviceId: raw.deviceId };
  const created: DeviceSettings = { deviceId: crypto.randomUUID() };
  saveDeviceSettings(app, created);
  return created;
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  app.saveLocalStorage(KEY, settings);
}
