import { describe, expect, it } from "vitest";
import { App, requestUrlMock } from "../../fakes/obsidian";
import { NtfyClient, NtfyError, MIN_DELAY_MS, testMessage, type NtfyMessage } from "../../../src/reminders/ntfy/client";
import { DEFAULT_NTFY_SERVER, normalizeServer, ntfyTarget, randomTopic, type NtfyConfig } from "../../../src/reminders/ntfy/config";
import { SecretIds, Secrets } from "../../../src/secrets/secrets";
import { loadDeviceSettings } from "../../../src/settings/device";
import { NTFY } from "./fixtures";

const NOW = Date.UTC(2026, 9, 8, 8); // Thu 8 Oct 2026, 10:00 Berlin
const target: NtfyConfig = { server: "https://ntfy.sh", topic: "osmm-SECRETTOPIC", token: null };
const client = (t: NtfyConfig | null = target) => new NtfyClient(() => t, undefined, () => NOW);
const msg: NtfyMessage = {
  title: "In 10 min · LinkedIn",
  message: "Event X is back",
  priority: 4,
  tags: ["osmm", "linkedin"],
  click: "https://www.linkedin.com/feed/?shareActive=true",
  actions: [{ action: "view", label: "Open note", url: "obsidian://open?vault=V&file=a.md" }],
};
const body = (i = 0) => JSON.parse(String(requestUrlMock.calls[i]!.body)) as Record<string, unknown>;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as NtfyError;
  }
  throw new Error("expected a failure");
};

describe("NtfyClient contract (#68)", () => {
  it("publishes JSON to the server root with title, message, priority, tags, click and actions", async () => {
    requestUrlMock.queue.push(NTFY.published);
    expect(await client().publish(msg)).toEqual({ id: "hwQ2YpKdmg", at: 1791216000_000 });
    const call = requestUrlMock.calls[0]!;
    expect([call.url, call.method, call.contentType, call.throw]).toEqual(["https://ntfy.sh/", "POST", "application/json", false]);
    expect(call.headers).toEqual({});
    expect(body()).toEqual({ topic: "osmm-SECRETTOPIC", title: msg.title, message: msg.message, priority: 4, tags: ["osmm", "linkedin"], click: msg.click, actions: msg.actions });
  });

  it("books a delayed push with a unix-seconds delay", async () => {
    requestUrlMock.queue.push(NTFY.scheduled, NTFY.published);
    const at = NOW + 2 * 3_600_000;
    expect(await client().publish({ ...msg, at })).toEqual({ id: "Zr0Jk2fA9b", at });
    expect(body().delay).toBe(String(Math.floor(at / 1000)));
    await client().publish({ ...msg, at: NOW + MIN_DELAY_MS - 1 });
    expect(body(1).delay).toBeUndefined();
  });

  it("sends the access token as a bearer header, and at most three actions", async () => {
    requestUrlMock.queue.push(NTFY.published);
    const view = { action: "view" as const, label: "x", url: "https://example.com" };
    await client({ ...target, token: "tk_SECRETTOKEN" }).publish({ ...msg, actions: [view, view, view, view] });
    expect(requestUrlMock.calls[0]!.headers).toEqual({ Authorization: "Bearer tk_SECRETTOKEN" });
    expect(body().actions).toHaveLength(3);
  });

  it("cancels a delayed push, or reports that the server can't", async () => {
    requestUrlMock.queue.push(NTFY.cancelled, NTFY.notFound);
    expect(await client().cancel("Zr0Jk2fA9b")).toBe("cancelled");
    expect([requestUrlMock.calls[0]!.url, requestUrlMock.calls[0]!.method]).toEqual(["https://ntfy.sh/osmm-SECRETTOPIC/Zr0Jk2fA9b", "DELETE"]);
    expect(await client().cancel("Zr0Jk2fA9b")).toBe("unsupported");
    expect(await client().cancel("../bad")).toBe("unsupported");
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it.each([
    ["forbidden", NTFY.forbidden, "auth", undefined],
    ["delay too large", NTFY.delayTooLarge, "rejected", undefined],
    ["rate limited", NTFY.rateLimited, "rate_limited", 60_000],
    ["bad gateway", NTFY.badGateway, "server", undefined],
    ["an unexpected reply", NTFY.garbled, "server", undefined],
    ["a network error", () => new Error("net::ERR_NAME_NOT_RESOLVED https://ntfy.sh/osmm-SECRETTOPIC"), "unreachable", undefined],
  ])("classifies %s", async (_name, fixture, kind, retryAfterMs) => {
    requestUrlMock.queue.push(fixture);
    const e = await failure(client().publish(msg));
    expect(e).toBeInstanceOf(NtfyError);
    expect([e.kind, e.retryAfterMs]).toEqual([kind, retryAfterMs]);
  });

  it("never puts the topic or the token in an error (review focus 3)", async () => {
    const withToken = client({ ...target, token: "tk_SECRETTOKEN" });
    for (const fixture of [NTFY.echoesSecrets, () => new Error("https://ntfy.sh/osmm-SECRETTOPIC tk_SECRETTOKEN")]) {
      requestUrlMock.queue.push(fixture);
      const e = await failure(withToken.publish(msg));
      expect(e.message).not.toMatch(/SECRETTOPIC|SECRETTOKEN/);
    }
  });

  it("refuses to send before it is set up", async () => {
    const e = await failure(client(null).publish(testMessage()));
    expect(e.kind).toBe("setup");
    expect(requestUrlMock.calls).toEqual([]);
  });
});

describe("ntfy configuration", () => {
  it("normalizes the server address", () => {
    expect(normalizeServer(" https://ntfy.example.org/ ")).toBe("https://ntfy.example.org");
    expect(normalizeServer("http://192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
    expect(normalizeServer("ftp://x")).toBeNull();
    expect(normalizeServer("https://ntfy.sh/?a=1")).toBeNull();
    expect(normalizeServer("ntfy.sh")).toBeNull();
  });

  it("makes long random topics", () => {
    expect(randomTopic()).toMatch(/^osmm-[a-z0-9]{24}$/);
    expect(randomTopic()).not.toBe(randomTopic());
  });

  it("reads the topic and token from secret storage only", () => {
    const app = new App();
    const secrets = new Secrets(app as never);
    const device = loadDeviceSettings(app as never);
    expect(device.ntfy).toEqual({ enabled: false, server: DEFAULT_NTFY_SERVER, results: false });
    expect(ntfyTarget(device, secrets)).toBeNull();
    secrets.set(SecretIds.ntfyTopic, "osmm-abc");
    expect(ntfyTarget(device, secrets)).toEqual({ server: "https://ntfy.sh", topic: "osmm-abc", token: null });
    secrets.set(SecretIds.ntfyToken, "tk_x");
    expect(ntfyTarget({ ntfy: { ...device.ntfy, server: "https://push.example.org/" } }, secrets)).toEqual({ server: "https://push.example.org", topic: "osmm-abc", token: "tk_x" });
    secrets.set(SecretIds.ntfyTopic, "has spaces");
    expect(ntfyTarget(device, secrets)).toBeNull();
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toContain("osmm-abc");
  });

  it("falls back to defaults for malformed device values", () => {
    const app = new App();
    app.saveLocalStorage("osmm-device", { deviceId: "d", ntfy: { enabled: "yes", server: "nope", results: 1 } });
    expect(loadDeviceSettings(app as never).ntfy).toEqual({ enabled: false, server: DEFAULT_NTFY_SERVER, results: false });
  });
});
