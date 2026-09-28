import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings, parseMinutesList } from "../../src/settings/settings";
import { loadDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";

const channel = { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" };

describe("migrateSettings", () => {
  it("returns defaults for empty data", () => {
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(undefined).schemaVersion).toBe(2);
  });

  it("migrates v0 data and normalizes the root folder", () => {
    const s = migrateSettings({ rootFolder: "/Content//Social/", weekStartsOn: 0 });
    expect(s.schemaVersion).toBe(2);
    expect(s.rootFolder).toBe("Content/Social");
    expect(s.weekStartsOn).toBe(0);
  });

  it("migrates v1 settings to v2 with default templates", () => {
    const s = migrateSettings({ schemaVersion: 1, rootFolder: "Social" });
    expect(s.schemaVersion).toBe(2);
    expect(s.scheduleTemplates.map((t) => t.name)).toEqual(["Launch"]);
  });

  it("keeps valid channels and drops invalid ones", () => {
    const s = migrateSettings({ schemaVersion: 1, channels: [channel, { ...channel, id: "fb/me" }], channelGroups: [{ id: "mine", name: "Mine", channelIds: ["li/me"] }] });
    expect(s.channels).toEqual([channel]);
    expect(s.channelGroups).toHaveLength(1);
  });

  it("falls back to defaults for invalid scalar values", () => {
    const s = migrateSettings({ schemaVersion: 1, rootFolder: "", weekStartsOn: 3, defaultReminders: ["x"], defaultStaggerMinutes: -1 });
    expect(s).toMatchObject({ rootFolder: "Social", weekStartsOn: 1, defaultReminders: [60, 10], defaultStaggerMinutes: 15 });
  });

  it("refuses settings from a newer plugin version", () => {
    expect(() => migrateSettings({ schemaVersion: 99 })).toThrow(/newer version/);
  });
});

describe("parseMinutesList", () => {
  it.each([
    ["60, 10", [60, 10]],
    ["60 10", [60, 10]],
    ["", []],
    ["1h", null],
    ["-5", null],
  ])("%s → %j", (input, expected) => {
    expect(parseMinutesList(input)).toEqual(expected);
  });
});

describe("device settings", () => {
  it("creates a stable device id in local storage only", () => {
    const app = createApp();
    const first = loadDeviceSettings(app);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadDeviceSettings(app)).toEqual(first);
  });
});
