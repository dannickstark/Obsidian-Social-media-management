import { getFrontMatterInfo, parseYaml } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Channel, Variant } from "../../../src/model/types";
import { DiscordAdapter, parseWebhook } from "../../../src/platforms/discord/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, trackedJob } from "../contract/harness";
import { call, formParts, json, queue, sentJson, text, type Fixture } from "../http";
import { makeCtx } from "../../ui/ctx";
import { discordCase } from "./contract";
import { DC, DC_TOKEN, DC_WEBHOOK } from "./fixtures";

/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}, ch: Partial<Channel> = {}): DeliveryJob => {
  const base = discordCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant }, channel: { ...base.channel, ...ch } });
};
const BASE = `https://discord.com/api/v10/webhooks/1200000000000000001/${DC_TOKEN}`;

afterEach(() => expectDigestReads());

describe("parseWebhook", () => {
  it("accepts discord.com, discordapp.com, canary and ptb webhook URLs, and nothing else", () => {
    expect(parseWebhook(DC_WEBHOOK)).toEqual({ id: "1200000000000000001", token: DC_TOKEN, base: BASE });
    expect(parseWebhook(`https://canary.discordapp.com/api/v9/webhooks/1/${DC_TOKEN}/`)?.id).toBe("1");
    expect(parseWebhook(`https://ptb.discord.com/api/webhooks/1/${DC_TOKEN}`)?.base).toBe(`https://discord.com/api/v10/webhooks/1/${DC_TOKEN}`);
    expect(parseWebhook("https://evil.example/api/webhooks/1/abc")).toBeNull();
    expect(parseWebhook(`http://discord.com/api/webhooks/1/${DC_TOKEN}`)).toBeNull();
    expect(parseWebhook(null)).toBeNull();
  });
});

describe("DiscordAdapter.publish", () => {
  it("posts JSON with ?wait=true, no mention pings, and the post-as overrides", async () => {
    queue(json(200, DC.webhook), json(200, DC.message));
    const j = job({}, { url: "https://event.example/x" }, { postAsName: "Event X", postAsAvatar: "https://event.example/logo.png" });
    expect(await new DiscordAdapter(contractDeps()).publish(j)).toEqual(discordCase.success.expect);
    expect(call(0)).toMatchObject({ url: BASE, method: "GET", throw: false });
    expect(call(1)).toMatchObject({ url: `${BASE}?wait=true`, method: "POST", contentType: "application/json", throw: false });
    expect(sentJson(1)).toEqual({
      content: "Doors open at 18:00\n\nhttps://event.example/x",
      allowed_mentions: { parse: [] },
      username: "Event X",
      avatar_url: "https://event.example/logo.png",
    });
  });

  it("never pings: @everyone in the text is sent with mentions switched off", async () => {
    queue(json(200, DC.webhook), json(200, DC.message));
    await new DiscordAdapter(contractDeps()).publish(job({ text: "@everyone Event X is on!" }));
    expect(sentJson(1)).toEqual({ content: "@everyone Event X is on!", allowed_mentions: { parse: [] } });
  });

  it("uploads images as attachments with their alt text", async () => {
    queue(json(200, DC.webhook), json(200, DC.message));
    await new DiscordAdapter(contractDeps()).publish(job({ media: [img("cover.png", 1080, 1080, { alt: "Crowd at the door" }), img("map.png", 1080, 1080, { alt: undefined })] }));
    const parts = formParts(1);
    expect(call(1)).toMatchObject({ url: `${BASE}?wait=true`, method: "POST" });
    expect(JSON.parse(parts.payload_json!.value!)).toEqual({
      content: "Doors open at 18:00",
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: "cover.png", description: "Crowd at the door" },
        { id: 1, filename: "map.png" },
      ],
    });
    expect(parts["files[0]"]).toEqual({ filename: "cover.png", type: "image/png", size: 8 });
    expect(parts["files[1]"]).toMatchObject({ filename: "map.png" });
  });

  it("waits UPLOAD_TIMEOUT_MS for a post with attachments, the client's timeout for the rest (Task 2 carry)", async () => {
    // The contract client times out after 50 ms; an answer after 120 ms still arrives for attachments, not for text.
    const late = (f: Fixture): Fixture => (req) => new Promise((resolve) => window.setTimeout(() => resolve(f(req)), 120));
    queue(json(200, DC.webhook), late(json(200, DC.message)));
    const adapter = new DiscordAdapter(contractDeps());
    expect(await adapter.publish(job({ media: [img("cover.png")] }))).toMatchObject({ remoteId: "1300000000000000004" });
    queue(late(json(200, DC.message)));
    await expect(adapter.publish(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("asks for the webhook's server once per session", async () => {
    const adapter = new DiscordAdapter(contractDeps());
    queue(json(200, DC.webhook), json(200, DC.message), json(200, DC.message));
    await adapter.publish(job());
    await adapter.publish(job());
    expect(requestUrlMock.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
  });

  it("refuses a missing or wrong credential before any request", async () => {
    await expect(new DiscordAdapter(contractDeps()).publish(job({ secret: null }))).rejects.toThrow(
      "Paste the webhook URL of dc/maker-lab as its credential on this device (Discord: Server settings → Integrations → Webhooks).",
    );
    await expect(new DiscordAdapter(contractDeps()).publish(job({ secret: "not a url" }))).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("says what to do when the webhook was deleted", async () => {
    queue(json(404, DC.unknownWebhook));
    await expect(new DiscordAdapter(contractDeps()).publish(job())).rejects.toMatchObject({
      kind: "needs_user",
      message: "Discord: Unknown Webhook. The webhook was deleted; create a new one and save its URL as this channel's credential. (HTTP 404)",
    });
  });

  it("waits out the global rate limit too, from the body's fractional retry_after or the Retry-After header", async () => {
    queue(json(200, DC.webhook), json(429, DC.globalRateLimited, { "X-RateLimit-Global": "true", "X-RateLimit-Scope": "global" }));
    const adapter = new DiscordAdapter(contractDeps());
    await expect(adapter.publish(job())).rejects.toMatchObject({ kind: "transient", retryAfterMs: 250, message: "Discord: You are being rate limited. (global rate limit) (HTTP 429)" });
    // A Cloudflare-level 429 has no JSON body: the header's wait is used.
    queue(text(429, "<html>Too many requests</html>", { "Retry-After": "3" }));
    await expect(adapter.publish(job())).rejects.toMatchObject({ kind: "transient", retryAfterMs: 3000 });
  });

  it("has no hand-over and no lookup: a webhook can't schedule, and its message can't be found without the lost id (M5 P2)", () => {
    const a = new DiscordAdapter(contractDeps());
    expect("schedule" in a).toBe(false);
    expect("lookup" in a).toBe(false);
    expect("update" in a).toBe(false);
    expect("cancel" in a).toBe(false);
  });
});

describe("the webhook URL never reaches a message (M5 G4)", () => {
  // requestUrl's own error can name the URL, and the token is in the URL's path.
  const leaky: Fixture = (req) => new Error(`net::ERR_FAILED ${req.url}`);

  it("keeps it out of publish and verify errors, even when an error body echoes it", async () => {
    const messages: string[] = [];
    const collect = (e: Error) => void messages.push(e.message);
    queue(leaky);
    await new DiscordAdapter(contractDeps()).publish(job()).catch(collect);
    queue(leaky);
    const v = await new DiscordAdapter(contractDeps()).verify(job().channel, DC_WEBHOOK);
    if (!v.ok) messages.push(v.error);
    queue(json(401, { message: `Invalid Webhook Token ${DC_WEBHOOK}`, code: 50027 }));
    await new DiscordAdapter(contractDeps()).publish(job()).catch(collect);
    queue(json(400, { message: `bad ${encodeURIComponent(DC_WEBHOOK)}`, code: 0 }));
    await new DiscordAdapter(contractDeps()).publish(job()).catch(collect);
    queue(json(404, { message: `no ${BASE}`, code: 0 }));
    const v2 = await new DiscordAdapter(contractDeps()).verify(job().channel, DC_WEBHOOK);
    if (!v2.ok) messages.push(v2.error);
    // A token on another webhook URL (a copy of the credential in a different form) is caught by its shape.
    queue(json(403, { message: `see https://discordapp.com/api/webhooks/9/${"a".repeat(68)}`, code: 0 }));
    await new DiscordAdapter(contractDeps()).publish(job()).catch(collect);
    expect(messages).toHaveLength(6);
    expect(messages.slice(2, 4)).toEqual(["Discord: Invalid Webhook Token [webhook URL] (HTTP 401)", "Discord: bad [webhook URL] (HTTP 400)"]);
    for (const m of messages) for (const s of [DC_WEBHOOK, DC_TOKEN, encodeURIComponent(DC_WEBHOOK), "a".repeat(68)]) expect(m).not.toContain(s);
  });
});

describe("DiscordAdapter.verify", () => {
  it("names the webhook, or explains why it can't be used", async () => {
    queue(json(200, DC.webhook), json(404, DC.unknownWebhook));
    const adapter = new DiscordAdapter(contractDeps());
    expect(await adapter.verify(job().channel, DC_WEBHOOK)).toEqual({ ok: true, account: 'webhook "OSMM"' });
    expect(await new DiscordAdapter(contractDeps()).verify(job().channel, DC_WEBHOOK)).toMatchObject({ ok: false });
    expect(await adapter.verify(job().channel, null)).toMatchObject({ ok: false });
  });
});

describe("an interrupted Discord post (M5 P2)", () => {
  it("a 502 on the webhook execute parks the delivery on check_needed and sends once", async () => {
    const P = "Social/Posts/Dc.md";
    const c = await makeCtx({
      seed: true,
      now: CONTRACT_NOW,
      notes: [{ path: P, frontmatter: { type: "social-post", platform: "discord", channels: ["dc/maker-lab"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "dc/maker-lab": { status: "scheduled" } } }, body: "Doors open at 18:00" }],
    });
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("dc/maker-lab")!, secretId: "osmm-channel-dc-maker-lab" });
    c.app.secretStorage.setSecret("osmm-channel-dc-maker-lab", DC_WEBHOOK);
    c.adapters.register(new DiscordAdapter(contractDeps()));
    const status = async () => {
      const fm = parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, { status: string; error?: string }> };
      return fm.deliveries["dc/maker-lab"]!;
    };
    queue(json(200, DC.webhook), json(502, { message: "502: Bad Gateway", code: 0 }), json(200, DC.message));
    expect(await c.ctx.publish.orchestrator.run(P, "dc/maker-lab")).toEqual({ status: "check_needed" });
    // check_needed is not claimable: a second run sends nothing.
    await c.ctx.publish.orchestrator.run(P, "dc/maker-lab");
    expect(requestUrlMock.calls.map((x) => x.method)).toEqual(["GET", "POST"]);
    const d = await status();
    expect(d.status).toBe("check_needed");
    expect(d.error).not.toContain(DC_TOKEN);
  });
});
