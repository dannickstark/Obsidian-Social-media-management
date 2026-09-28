import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings, parseMinutesList } from "../../src/settings/settings";
import { loadDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";
import { zChannel } from "../../src/model/schemas";

const channel = { id: "li/me", platform: "linkedin", name: "Me", kind: "profile", avatarColor: "#c9c3b8", method: "api" };

describe("migrateSettings", () => {
  it("returns defaults for empty data", () => {
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(undefined).schemaVersion).toBe(5);
  });

  it("migrates v0 data and normalizes the root folder", () => {
    const s = migrateSettings({ rootFolder: "/Content//Social/", weekStartsOn: 0 });
    expect(s.schemaVersion).toBe(5);
    expect(s.rootFolder).toBe("Content/Social");
    expect(s.weekStartsOn).toBe(0);
  });

  it("migrates v1 settings to v3 with default templates", () => {
    const s = migrateSettings({ schemaVersion: 1, rootFolder: "Social" });
    expect(s.schemaVersion).toBe(5);
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

  it("migrates v2 settings to v3 with no publisher device", () => {
    expect(migrateSettings({ schemaVersion: 2, rootFolder: "Social" }).publisher).toBeNull();
  });

  it("keeps a valid publisher record and drops a malformed one", () => {
    const publisher = { deviceId: "d-1", name: "Studio iMac", since: 5 };
    expect(migrateSettings({ schemaVersion: 3, publisher }).publisher).toEqual(publisher);
    expect(migrateSettings({ schemaVersion: 3, publisher: { name: "x" } }).publisher).toBeNull();
    expect(migrateSettings({ schemaVersion: 3, publisher: { deviceId: "d-1", name: " ", since: "x" } }).publisher).toEqual({ deviceId: "d-1", name: "another device", since: 0 });
  });

  it("adds publishWithoutAsking in schema 4 and keeps only channel ids", () => {
    expect(migrateSettings({ schemaVersion: 3 }).publishWithoutAsking).toEqual([]);
    expect(migrateSettings({ schemaVersion: 4, publishWithoutAsking: ["tg/event-x", "nope", 3] }).publishWithoutAsking).toEqual(["tg/event-x"]);
  });

  it("refuses settings from a newer plugin version", () => {
    expect(() => migrateSettings({ schemaVersion: 99 })).toThrow(/newer version/);
  });

  it("migrates schema 4 to 5 and keeps the M5 channel fields", () => {
    const s = migrateSettings({
      schemaVersion: 4,
      channels: [
        { id: "wp/blog", platform: "wordpress", name: "Blog", kind: "site", avatarColor: "#888888", method: "native", server: "https://blog.example.com/", login: "editor" },
        { id: "dc/news", platform: "discord", name: "News", kind: "server_channel", avatarColor: "#888888", method: "api", postAsName: "OSMM", postAsAvatar: "https://example.com/a.png" },
      ],
    });
    expect(s.schemaVersion).toBe(5);
    expect(s.channels[0]).toMatchObject({ server: "https://blog.example.com", login: "editor" });
    expect(s.channels[1]).toMatchObject({ postAsName: "OSMM", postAsAvatar: "https://example.com/a.png" });
  });

  it("accepts only https for a channel's server", () => {
    const wp = { id: "wp/blog", platform: "wordpress", name: "Blog", kind: "site", avatarColor: "#888888", method: "native" };
    expect(zChannel.safeParse({ ...wp, server: "http://blog.example.com" }).success).toBe(false);
    expect(zChannel.safeParse({ ...wp, server: "https://blog.example.com/wp" }).success).toBe(true);
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
