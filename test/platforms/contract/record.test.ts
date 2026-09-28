// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpFn } from "../../../src/platforms/http";
import { recordingHttp, replay } from "./record";

describe("recordingHttp", () => {
  it("masks secrets in the URL, the body and the answer, and summarises binary bodies", async () => {
    const inner: HttpFn = async () => ({ status: 200, headers: { "x-token": "SECRET-1234" }, text: '{"token":"SECRET-1234"}', arrayBuffer: new ArrayBuffer(0) });
    const { http, exchanges } = recordingHttp(inner, ["SECRET-1234"]);
    await http({ url: "https://api.telegram.org/botSECRET-1234/getMe", method: "POST", body: '{"a":"SECRET-1234"}' });
    await http({ url: "https://x.example/upload", method: "POST", body: new Uint8Array([1, 2, 3]).buffer });
    expect(JSON.stringify(exchanges)).not.toContain("SECRET-1234");
    expect(exchanges[1]!.request.body).toBe("<binary 3 bytes>");
    expect(replay(exchanges)).toHaveLength(2);
  });
});

/**
 * Live recording (QA, never in CI): OSMM_RECORD=telegram OSMM_SECRET=… OSMM_HANDLE=@chan npx vitest run test/platforms/contract/record.test.ts
 * writes test/platforms/<platform>/recorded/publish.json. Compare it with the doc-written fixtures, then delete it or
 * turn it into a fixture. Uses Node's fetch, so it can run outside Obsidian.
 */
describe.skipIf(!process.env.OSMM_RECORD)("live recording", () => {
  it("records one publish", async () => {
    (globalThis as { window?: unknown }).window ??= globalThis;
    const { createAdapters } = await import("../../../src/platforms/adapters");
    const { channel } = await import("../fixtures");
    const platform = process.env.OSMM_RECORD ?? "";
    const secret = process.env.OSMM_SECRET ?? "";
    const fetchHttp: HttpFn = async (req) => {
      const headers = { ...(req.headers ?? {}), ...(req.contentType ? { "Content-Type": req.contentType } : {}) };
      const res = await fetch(req.url, { method: req.method ?? "GET", headers, ...(req.body !== undefined ? { body: req.body } : {}) });
      const arrayBuffer = await res.arrayBuffer();
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
    };
    const { http, exchanges } = recordingHttp(fetchHttp, [secret]);
    const adapter = createAdapters({ http, now: () => Date.now(), readBinary: async () => new ArrayBuffer(0), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }).find((a) => a.platform === platform)!;
    const prefix = { telegram: "tg", discord: "dc", mastodon: "ma", bluesky: "bs", wordpress: "wp" }[platform] ?? "x";
    const text = `OSMM fixture recording ${new Date().toISOString()}`;
    await adapter.publish!({
      variant: { path: "Social/Record.md", platform: platform as never, channels: [], mode: "auto", status: "scheduled", media: [], deliveries: {}, title: text, wordpress: { slug: `osmm-record-${Date.now()}`, categories: [], tags: [] } },
      channel: channel(`${prefix}/record`, { handle: process.env.OSMM_HANDLE, server: process.env.OSMM_SERVER, login: process.env.OSMM_LOGIN }),
      delivery: { status: "publishing", at: Date.now(), attempts: 1 },
      text,
      items: [text],
      body: text,
      media: [],
      secret,
    }).finally(() => {
      const file = join("test/platforms", platform, "recorded", "publish.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(exchanges, null, 2)}\n`);
    });
    expect(exchanges.length).toBeGreaterThan(0);
  });
});
