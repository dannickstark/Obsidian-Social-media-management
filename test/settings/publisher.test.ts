import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { App, setPlatform } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { newDeviceId, randomString } from "../../src/model/ids";
import type { DueItem } from "../../src/scheduler/due";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanDeviceName, defaultDeviceName, loadDeviceSettings } from "../../src/settings/device";
import { PublisherService, publisherDescription, publisherState } from "../../src/settings/publisher";
import { migrateSettings, type OsmmSettings } from "../../src/settings/settings";
import { makeCtx } from "../ui/ctx";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin

/** Two devices sharing one synced data.json, each with its own device-local storage. */
function twoDevices() {
  let synced: OsmmSettings = migrateSettings(null);
  const device = (app: App) => {
    const local = loadDeviceSettings(app as never);
    return new PublisherService({
      device: () => local,
      settings: () => synced,
      update: async (patch) => {
        synced = migrateSettings({ ...synced, ...patch });
      },
      now: () => T,
    });
  };
  return { laptop: device(new App()), phone: device(new App()), synced: () => synced };
}

describe("ids", () => {
  it("makes UUID-shaped device ids and random strings without randomUUID", () => {
    expect(newDeviceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newDeviceId()).not.toBe(newDeviceId());
    expect(randomString(24)).toMatch(/^[a-z0-9]{24}$/);
  });

  it("refuses an alphabet it cannot sample without bias", () => {
    expect(() => randomString(4, "")).toThrow(/alphabet/);
    expect(() => randomString(4, "a".repeat(257))).toThrow(/alphabet/);
    expect(randomString(4, "ab".repeat(128))).toMatch(/^[ab]{4}$/);
  });
});

describe("device name", () => {
  it("defaults to the kind of device and is editable", () => {
    expect(defaultDeviceName()).toBe("Mac");
    setPlatform("iphone");
    expect(defaultDeviceName()).toBe("iPhone");
    setPlatform("android");
    expect(defaultDeviceName()).toBe("Android phone");
    expect(cleanDeviceName("  Studio   iMac ")).toBe("Studio iMac");
    expect(cleanDeviceName("   ")).toBeNull();
    expect(cleanDeviceName("x".repeat(60))).toHaveLength(40);
  });

  it("is stored on the device, next to the device id", () => {
    const app = new App();
    const first = loadDeviceSettings(app as never);
    expect(first.deviceName).toBe("Mac");
    expect(app.loadLocalStorage("osmm-device")).toMatchObject({ deviceId: first.deviceId, deviceName: "Mac" });
  });
});

describe("PublisherService", () => {
  it("nobody publishes until a device is chosen", () => {
    const { laptop, phone } = twoDevices();
    expect([laptop.isPublisher(), phone.isPublisher()]).toEqual([false, false]);
    expect(laptop.state()).toEqual({ kind: "none" });
  });

  it("only the claimed device publishes; the other one sees its name (two fake devices)", async () => {
    const { laptop, phone, synced } = twoDevices();
    await laptop.claim();
    expect(synced().publisher).toEqual({ deviceId: laptop.deviceId, name: "Mac", since: T });
    expect(laptop.isPublisher()).toBe(true);
    expect(phone.isPublisher()).toBe(false);
    expect(phone.state()).toEqual({ kind: "other", name: "Mac", since: T });
  });

  it("asks before taking over, and moves the role only when confirmed", async () => {
    const { laptop, phone } = twoDevices();
    await laptop.claim();
    const asked: string[] = [];
    expect(await phone.takeOver(async (m) => (asked.push(m), false))).toBe(false);
    expect(laptop.isPublisher()).toBe(true);
    expect(asked[0]).toMatch(/^Publishing happens on Mac\. Make this device the publisher instead\?/);
    expect(await phone.takeOver(async () => true)).toBe(true);
    expect([laptop.isPublisher(), phone.isPublisher()]).toEqual([false, true]);
  });

  it("claims without asking when no device publishes", async () => {
    const { laptop } = twoDevices();
    let asked = false;
    await laptop.takeOver(async () => (asked = true));
    expect(asked).toBe(false);
    expect(laptop.isPublisher()).toBe(true);
  });

  it("releases the role only on the publisher", async () => {
    const { laptop, phone, synced } = twoDevices();
    await laptop.claim();
    await phone.release();
    expect(laptop.isPublisher()).toBe(true);
    await laptop.release();
    expect(synced().publisher).toBeNull();
  });

  it("keeps the synced name in step after a rename", async () => {
    let synced = migrateSettings(null);
    const local = { deviceId: "d1", deviceName: "Mac" };
    const service = new PublisherService({ device: () => local, settings: () => synced, update: async (p) => void (synced = { ...synced, ...p }), now: () => T });
    await service.renamed();
    expect(synced.publisher).toBeNull();
    await service.claim();
    local.deviceName = "Studio iMac";
    await service.renamed();
    expect(synced.publisher).toEqual({ deviceId: "d1", name: "Studio iMac", since: T });
  });

  it("describes each state", () => {
    expect(publisherState(null, "a")).toEqual({ kind: "none" });
    expect(publisherDescription({ kind: "other", name: "Work laptop", since: 0 })).toContain("Publishing happens on Work laptop.");
    expect(publisherDescription({ kind: "this" })).toContain("This device posts scheduled items");
  });
});

describe("Scheduler on two devices (#26 acceptance)", () => {
  it("runs deliveries only on the publisher", async () => {
    const A = "Social/Posts/A.md";
    const c = await makeCtx({
      notes: [{ path: A, frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(T), deliveries: { "bs/you": { status: "scheduled" } } }, body: "Hi" }],
      now: T,
    });
    const { laptop, phone } = twoDevices();
    await laptop.claim();
    const run = (who: PublisherService) => {
      const dispatched: string[] = [];
      const scheduler = new Scheduler({
        index: c.index,
        settings: () => get(c.settings),
        now: () => T,
        isPublisher: () => who.isPublisher(),
        autoPostLateMs: () => null,
        publish: {
          dispatch: async (i: DueItem) => void dispatched.push(i.key),
          markOverdue: async () => undefined,
          markCheckNeeded: async () => false,
          resolveCheck: async () => undefined,
        },
        warn: () => undefined,
      });
      return { scheduler, dispatched };
    };
    const onPhone = run(phone);
    const onLaptop = run(laptop);
    // Ticks are no-ops until the startup reconcile has run (M3 P3).
    await onPhone.scheduler.reconcile();
    await onPhone.scheduler.tick();
    await onLaptop.scheduler.reconcile();
    await onLaptop.scheduler.tick();
    expect(onPhone.dispatched).toEqual([]);
    expect(onLaptop.dispatched).toEqual([`${A}#bs/you@${T}`]);
  });
});
