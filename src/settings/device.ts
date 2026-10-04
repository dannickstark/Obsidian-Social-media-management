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

/** The local MCP server for Claude Code on this device (#73, #78). Its token lives in secret storage, never here. */
export interface McpDeviceSettings {
  enabled: boolean;
  port: number;
}

export interface CredentialHealth {
  status: "verified" | "expired" | "refresh-failed" | "test-failed";
  expiresAt?: number;
  /** Local de-duplication key for one status/expiry reminder; never a token. */
  notifiedKey?: string;
}

export const DEFAULT_MCP_PORT = 27150;

/** A TCP port the user may pick: an integer from 1024 to 65535 (no privileged ports). */
export function parsePort(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function sanitizeMcp(raw: unknown): McpDeviceSettings {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {};
  return { enabled: r.enabled === true, port: parsePort(r.port) ?? DEFAULT_MCP_PORT };
}

/** Settings that must never sync between devices (stored in vault-scoped localStorage). */
export interface DeviceSettings {
  deviceId: string;
  /** Shown on other devices as "Publishing happens on <name>" (spec §4.3). */
  deviceName: string;
  /** Desktop notifications on this device (spec §4.3: each device fires its own if enabled). */
  notifications: boolean;
  ntfy: NtfyDeviceSettings;
  mcp: McpDeviceSettings;
  credentialHealth?: Record<string, CredentialHealth>;
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

function sanitizeCredentialHealth(raw: unknown): Record<string, CredentialHealth> {
  if (!isRecord(raw)) return {};
  const health: Record<string, CredentialHealth> = {};
  for (const [channelId, value] of Object.entries(raw)) {
    if (!channelId || !isRecord(value) || (value.status !== "verified" && value.status !== "expired" && value.status !== "refresh-failed" && value.status !== "test-failed")) continue;
    const expiresAt = typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt >= 0 ? value.expiresAt : undefined;
    const notifiedKey = typeof value.notifiedKey === "string" && /^(?:refresh-failed|test-failed|expired(?::\d+)?|expiring:\d+)$/.test(value.notifiedKey) ? value.notifiedKey : undefined;
    health[channelId] = {
      status: value.status,
      ...(value.status === "verified" && expiresAt !== undefined ? { expiresAt } : {}),
      ...(notifiedKey ? { notifiedKey } : {}),
    };
  }
  return health;
}

function sanitize(raw: Record<string, unknown>, deviceId: string): DeviceSettings {
  return {
    deviceId,
    deviceName: cleanDeviceName(raw.deviceName) ?? defaultDeviceName(),
    notifications: raw.notifications !== false,
    ntfy: sanitizeNtfy(raw.ntfy),
    mcp: sanitizeMcp(raw.mcp),
    credentialHealth: sanitizeCredentialHealth(raw.credentialHealth),
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

/** Writes only a status and optional expiry into device-local settings. */
export class CredentialHealthStore {
  constructor(private readonly read: () => DeviceSettings, private readonly write: (next: DeviceSettings) => void) {}

  get(channelId: string): CredentialHealth | null {
    return this.read().credentialHealth?.[channelId] ?? null;
  }

  setVerified(channelId: string, expiresAt?: number): void {
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new Error("Invalid credential expiry.");
    this.set(channelId, expiresAt === undefined ? { status: "verified" } : { status: "verified", expiresAt });
  }

  setExpired(channelId: string): void { this.set(channelId, { status: "expired" }); }

  setRefreshFailed(channelId: string): void { this.set(channelId, { status: "refresh-failed" }); }

  setTestFailed(channelId: string): void { this.set(channelId, { status: "test-failed" }); }

  markNotified(channelId: string, noticeKey: string): void {
    if (!/^(?:refresh-failed|test-failed|expired(?::\d+)?|expiring:\d+)$/.test(noticeKey)) throw new Error("Invalid credential notice key.");
    const health = this.get(channelId);
    if (health) this.set(channelId, { ...health, notifiedKey: noticeKey });
  }

  clear(channelId: string): void {
    const credentialHealth = { ...this.read().credentialHealth };
    delete credentialHealth[channelId];
    this.write({ ...this.read(), credentialHealth });
  }

  private set(channelId: string, health: CredentialHealth): void {
    if (!channelId) throw new Error("Channel id is required.");
    const device = this.read();
    const previous = device.credentialHealth?.[channelId];
    const notifiedKey = health.notifiedKey ?? (previous?.status === health.status && previous?.expiresAt === health.expiresAt ? previous.notifiedKey : undefined);
    this.write({ ...device, credentialHealth: { ...device.credentialHealth, [channelId]: { ...health, ...(notifiedKey ? { notifiedKey } : {}) } } });
  }
}
