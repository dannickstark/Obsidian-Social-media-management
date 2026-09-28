import { Platform, type App } from "obsidian";
import { isRecord } from "../model/frontmatter";
import { newDeviceId } from "../model/ids";
import { DEFAULT_NTFY_SERVER, normalizeServer } from "../reminders/ntfy/config";

/** Phone reminders on this device (#71). The topic and the token live in secret storage, never here. */
export interface NtfyDeviceSettings {
  enabled: boolean;
  server: string;
  /** Also push automatic-post confirmations and failure alerts (#70, optional). */
  results: boolean;
}

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
  /** Shown on other devices as "Publishing happens on <name>" (spec §4.3). */
  deviceName: string;
  /** Desktop notifications on this device (spec §4.3: each device fires its own if enabled). */
  notifications: boolean;
  ntfy: NtfyDeviceSettings;
}

const KEY = "osmm-device";
const MAX_NAME = 40;

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows PC";
  if (Platform.isLinux) return "Linux PC";
  return "This device";
}

export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return name || null;
}

function sanitizeNtfy(raw: unknown): NtfyDeviceSettings {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {};
  const server = typeof r.server === "string" ? normalizeServer(r.server) : null;
  return { enabled: r.enabled === true, server: server ?? DEFAULT_NTFY_SERVER, results: r.results === true };
}

function sanitize(raw: Record<string, unknown>, deviceId: string): DeviceSettings {
  return {
    deviceId,
    deviceName: cleanDeviceName(raw.deviceName) ?? defaultDeviceName(),
    notifications: raw.notifications !== false,
    ntfy: sanitizeNtfy(raw.ntfy),
  };
}

export function loadDeviceSettings(app: App): DeviceSettings {
  const raw: unknown = app.loadLocalStorage(KEY);
  const record = isRecord(raw) ? raw : {};
  const id = typeof record.deviceId === "string" && record.deviceId ? record.deviceId : newDeviceId();
  const settings = sanitize(record, id);
  saveDeviceSettings(app, settings);
  return settings;
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  app.saveLocalStorage(KEY, settings);
}
