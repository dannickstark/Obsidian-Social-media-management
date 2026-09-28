import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { get } from "svelte/store";
import { McpService, setupCommand, TOKEN_LENGTH } from "../../src/mcp/service";
import { SecretIds } from "../../src/secrets/secrets";
import type { McpDeviceSettings } from "../../src/settings/device";
import { freePort, portIsFree } from "./net";

const services: McpService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});

function build(opts: { desktop?: boolean; settings?: McpDeviceSettings } = {}) {
  const store = new Map<string, string>();
  let settings: McpDeviceSettings = opts.settings ?? { enabled: false, port: 27150 };
  let loads = 0;
  const service = new McpService({
    desktop: () => opts.desktop ?? true,
    settings: () => settings,
    secrets: { get: (id) => store.get(id) ?? null, set: (id, value) => void store.set(id, value) },
    handle: async (m) => ({ jsonrpc: "2.0", id: (m as { id?: number }).id ?? null, result: {} }),
    version: "0.4.0",
    now: () => 5_000,
    loadHttp: async () => {
      loads++;
      return http;
    },
  });
  services.push(service);
  return { service, store, loads: () => loads, set: (next: McpDeviceSettings) => void (settings = next) };
}

function status(port: number, token: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}

describe("McpService", () => {
  it("is off by default and creates nothing (#73)", async () => {
    const { service, store, loads } = build();
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
    expect(loads()).toBe(0);
    expect(store.size).toBe(0);
  });

  it("never loads Node's http on a phone, even when switched on", async () => {
    const { service, loads } = build({ desktop: false, settings: { enabled: true, port: 27150 } });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "unavailable" });
    expect(loads()).toBe(0);
  });

  it("starts with a new 256-bit token kept in secret storage only", async () => {
    const port = await freePort();
    const { service, store } = build({ settings: { enabled: true, port } });
    await service.apply();
    const token = store.get(SecretIds.mcpBearer)!;
    expect(token).toMatch(new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`));
    expect(get(service.status)).toEqual({ state: "on", port });
    expect(await service.testConnection()).toEqual({ ok: true });
    expect(service.setupCommand()).toBe(setupCommand(port, token));
    expect(service.setupCommand()).toBe(`claude mcp add --transport http --scope user --header "Authorization: Bearer ${token}" osmm http://127.0.0.1:${port}/mcp`);
    expect(service.maskedSetupCommand()).not.toContain(token);
    expect(await status(port, token)).toBe(200);
  });

  it("stops the old token at once after a rotation (review focus 4)", async () => {
    const port = await freePort();
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    const old = service.token()!;
    const next = service.rotateToken();
    expect(next).not.toBe(old);
    expect(await status(port, old)).toBe(401);
    expect(await status(port, next)).toBe(200);
  });

  it("moves to a new port and frees the old one", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const { service, set } = build({ settings: { enabled: true, port: a } });
    await service.apply();
    set({ enabled: true, port: b });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "on", port: b });
    expect(await portIsFree(a)).toBe(true);
  });

  it("reports a port in use and recovers once it is free", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    expect(get(service.status)).toMatchObject({ state: "error", message: expect.stringContaining("already in use") });
    await new Promise((r) => blocker.close(r));
    await service.apply();
    expect(get(service.status)).toEqual({ state: "on", port });
  });

  it("stops when switched off and when disposed, and stays off afterwards (review focus 4)", async () => {
    const port = await freePort();
    const { service, set } = build({ settings: { enabled: true, port } });
    await service.apply();
    set({ enabled: false, port });
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
    expect(await portIsFree(port)).toBe(true);
    set({ enabled: true, port });
    await service.apply();
    await service.dispose();
    expect(await portIsFree(port)).toBe(true);
    await service.apply();
    expect(get(service.status)).toEqual({ state: "off" });
  });

  it("starts once when asked twice at the same time", async () => {
    const port = await freePort();
    const { service, loads } = build({ settings: { enabled: true, port } });
    await Promise.all([service.apply(), service.apply()]);
    expect(loads()).toBe(1);
    expect(get(service.status)).toEqual({ state: "on", port });
  });

  it("records the last tool call and the last refused request", async () => {
    const port = await freePort();
    const { service } = build({ settings: { enabled: true, port } });
    await service.apply();
    service.record("create_variant");
    expect(await status(port, null)).toBe(401);
    expect(get(service.activity)).toEqual({ last: { at: 5_000, label: "create_variant" }, refused: { at: 5_000, status: 401 } });
  });

  it("says the server is off when testing a stopped server", async () => {
    const { service } = build();
    expect(await service.testConnection()).toEqual({ ok: false, message: "The server is off." });
  });
});
