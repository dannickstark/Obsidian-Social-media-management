import type { CredentialHealth, CredentialHealthStore } from "./device";

export type CredentialHealthKind = "disconnected" | "untested" | "verified" | "unknown-expiry" | "expiring" | "expired" | "refresh-failed" | "test-failed";

export interface CredentialHealthState {
  kind: CredentialHealthKind;
  label: string;
  /** A stable, non-secret key for an actionable issue. */
  noticeKey?: string;
}

const EXPIRING_WINDOW_MS = 7 * 86_400_000;

/** Derive a display state only from provider-confirmed metadata and the local credential. */
export function credentialHealthState(health: CredentialHealth | null, connected: boolean, now: number): CredentialHealthState {
  if (!connected) return { kind: "disconnected", label: "Disconnected on this device" };
  if (!health) return { kind: "untested", label: "Connection not tested" };
  if (health.status === "refresh-failed") return { kind: "refresh-failed", label: "Needs attention · refresh failed", noticeKey: "refresh-failed" };
  if (health.status === "test-failed") return { kind: "test-failed", label: "Needs attention · connection test failed", noticeKey: "test-failed" };
  if (health.status === "expired") return { kind: "expired", label: "Needs attention · credential expired", noticeKey: "expired" };
  if (health.expiresAt === undefined) return { kind: "unknown-expiry", label: "Verified · expiry unknown" };
  if (health.expiresAt <= now) return { kind: "expired", label: "Needs attention · credential expired", noticeKey: `expired:${health.expiresAt}` };
  if (health.expiresAt - now <= EXPIRING_WINDOW_MS) return { kind: "expiring", label: "Expires soon", noticeKey: `expiring:${health.expiresAt}` };
  return { kind: "verified", label: "Verified" };
}

export interface HealthReminderChannel { id: string; name: string; connected: boolean }

/** Desktop reminders are local and emitted once per status/expiry transition. */
export class CredentialHealthReminders {
  constructor(private readonly store: CredentialHealthStore, private readonly notify: (message: string) => void) {}

  scan(channels: readonly HealthReminderChannel[], now: number): void {
    for (const channel of channels) {
      const health = this.store.get(channel.id);
      const state = credentialHealthState(health, channel.connected, now);
      if (!state.noticeKey || health?.notifiedKey === state.noticeKey) continue;
      this.notify(`${channel.name}: ${state.label}. Test the connection in channel settings.`);
      this.store.markNotified(channel.id, state.noticeKey);
    }
  }
}
