import { describe, expect, it, vi } from "vitest";
import { App } from "../fakes/obsidian";
import { CredentialHealthStore, loadDeviceSettings, saveDeviceSettings } from "../../src/settings/device";
import { CredentialHealthReminders, credentialHealthState } from "../../src/settings/credentialHealth";

const NOW = Date.UTC(2026, 9, 8, 8);

function fixture() {
  const app = new App();
  let device = loadDeviceSettings(app as never);
  const store = new CredentialHealthStore(() => device, (next) => { device = next; saveDeviceSettings(app as never, next); });
  return { app, store, device: () => device };
}

describe("credential health", () => {
  it("distinguishes verified, expiring, expired, and unknown expiry using a precise provider time", () => {
    expect(credentialHealthState({ status: "verified", expiresAt: NOW + 8 * 86_400_000 }, true, NOW).kind).toBe("verified");
    expect(credentialHealthState({ status: "verified", expiresAt: NOW + 7 * 86_400_000 }, true, NOW).kind).toBe("expiring");
    expect(credentialHealthState({ status: "verified", expiresAt: NOW }, true, NOW).kind).toBe("expired");
    expect(credentialHealthState({ status: "verified" }, true, NOW).kind).toBe("unknown-expiry");
  });

  it("shows refresh failures separately and treats a missing local secret as disconnected", () => {
    expect(credentialHealthState({ status: "refresh-failed" }, true, NOW).kind).toBe("refresh-failed");
    expect(credentialHealthState({ status: "verified", expiresAt: NOW + 86_400_000 }, false, NOW).kind).toBe("disconnected");
    expect(credentialHealthState(null, true, NOW).kind).toBe("untested");
  });

  it("persists only allowlisted non-secret fields on this device", () => {
    const { app, store } = fixture();
    store.setVerified("x/main", NOW + 86_400_000);
    store.setRefreshFailed("x/main");
    expect(store.get("x/main")).toEqual({ status: "refresh-failed" });
    app.saveLocalStorage("osmm-device", { credentialHealth: { "x/main": { status: "verified", expiresAt: NOW, accessToken: "SECRET", refreshToken: "REFRESH", notifiedKey: "expired:1" } } });
    const reloaded = loadDeviceSettings(app as never);
    expect(reloaded.credentialHealth?.["x/main"]).toEqual({ status: "verified", expiresAt: NOW, notifiedKey: "expired:1" });
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toMatch(/SECRET|REFRESH/);
  });

  it("notifies once per issue and again only when a new expiry creates a new issue", () => {
    const { store } = fixture();
    const emit = vi.fn();
    const reminders = new CredentialHealthReminders(store, emit);
    store.setVerified("x/main", NOW + 86_400_000);
    reminders.scan([{ id: "x/main", name: "X Main", connected: true }], NOW);
    reminders.scan([{ id: "x/main", name: "X Main", connected: true }], NOW + 60_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toContain("X Main");
    store.setVerified("x/main", NOW + 2 * 86_400_000);
    reminders.scan([{ id: "x/main", name: "X Main", connected: true }], NOW);
    expect(emit).toHaveBeenCalledTimes(2);
    reminders.scan([{ id: "x/main", name: "X Main", connected: false }], NOW);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("moves from expiring to expired once without repeating after restart", () => {
    const { store } = fixture();
    const emit = vi.fn();
    store.setVerified("x/main", NOW + 1_000);
    new CredentialHealthReminders(store, emit).scan([{ id: "x/main", name: "X Main", connected: true }], NOW);
    new CredentialHealthReminders(store, emit).scan([{ id: "x/main", name: "X Main", connected: true }], NOW + 1_000);
    new CredentialHealthReminders(store, emit).scan([{ id: "x/main", name: "X Main", connected: true }], NOW + 2_000);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
