import { getFrontMatterInfo, parseYaml } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import { requestUrlMock } from "../../fakes/obsidian";
import type { Channel, Variant } from "../../../src/model/types";
import { TelegramAdapter } from "../../../src/platforms/telegram/api";
import type { DeliveryJob } from "../../../src/platforms/types";
import { img } from "../fixtures";
import { contractDeps, CONTRACT_NOW, expectDigestReads, trackedJob } from "../contract/harness";
import { call, formParts, hang, json, queue, sentJson, type Fixture } from "../http";
import { telegramCase } from "./contract";
import { TG, TG_TOKEN } from "./fixtures";
import { makeCtx } from "../../ui/ctx";

const adapter = () => new TelegramAdapter(contractDeps());
/** Every job's variant goes through the read guard (M5 P8); overrides are applied before it is wrapped. */
const job = (extra: Partial<DeliveryJob> = {}, variant: Partial<Variant> = {}, ch: Partial<Channel> = {}): DeliveryJob => {
  const base = telegramCase.job();
  return trackedJob({ ...base, ...extra, variant: { ...base.variant, ...variant }, channel: { ...base.channel, ...ch } });
};
const API = `https://api.telegram.org/bot${TG_TOKEN}`;

afterEach(() => expectDigestReads());

describe("TelegramAdapter.publish", () => {
  it("sends text as HTML to the channel and links the message", async () => {
    queue(json(200, TG.sendMessage));
    expect(await adapter().publish(job({ text: "**Doors** open & free" }))).toEqual({ remoteId: "42", url: "https://t.me/eventx/42" });
    expect(call(0)).toMatchObject({ url: `${API}/sendMessage`, method: "POST", contentType: "application/json", throw: false });
    expect(sentJson(0)).toEqual({ chat_id: "@eventx", text: "<b>Doors</b> open &amp; free", parse_mode: "HTML" });
  });

  it("links a message in a private channel through t.me/c", async () => {
    queue(json(200, TG.sendMessagePrivate));
    const j = job({}, {}, { handle: "-1009876543210" });
    expect((await adapter().publish(j)).url).toBe("https://t.me/c/9876543210/7");
    expect(sentJson(0).chat_id).toBe("-1009876543210");
  });

  it("adds the post's url on its own line when the text doesn't have it", async () => {
    queue(json(200, TG.sendMessage));
    await adapter().publish(job({}, { url: "https://event.example/x" }));
    expect(sentJson(0).text).toBe("Doors open at 18:00\n\nhttps://event.example/x");
  });

  it("sends one photo with the text as its caption", async () => {
    queue(json(200, TG.sendPhoto));
    expect(await adapter().publish(job({ text: "Doors open", media: [img("cover.png")] }))).toEqual({ remoteId: "43", url: "https://t.me/eventx/43" });
    expect(call(0).url).toBe(`${API}/sendPhoto`);
    expect(formParts(0)).toEqual({
      chat_id: { value: "@eventx", size: 7 },
      caption: { value: "Doors open", size: 10 },
      parse_mode: { value: "HTML", size: 4 },
      photo: { filename: "cover.png", type: "image/png", size: 8 },
    });
  });

  it("splits a long caption: the photo first, then the text as a message (#88)", async () => {
    queue(json(200, TG.sendPhoto), json(200, TG.sendMessage));
    const long = "x".repeat(1500);
    expect(await adapter().publish(job({ text: long, media: [img("cover.png")] }))).toEqual({ remoteId: "42", url: "https://t.me/eventx/42" });
    expect(formParts(0).caption).toBeUndefined();
    expect(sentJson(1)).toEqual({ chat_id: "@eventx", text: long, parse_mode: "HTML" });
  });

  it("keeps the photo as the post when the text after it fails, and says so", async () => {
    queue(json(200, TG.sendPhoto), json(400, TG.tooLong));
    const res = await adapter().publish(job({ text: "x".repeat(1500), media: [img("cover.png")] }));
    expect(res).toMatchObject({ remoteId: "43", url: "https://t.me/eventx/43" });
    expect(res.note).toBe("The photo was posted, but the text after it was not: Telegram: Bad Request: message is too long (HTTP 400)");
  });

  it("says the text after the photo may be out when its send gets a 502 (M5 P2)", async () => {
    queue(json(200, TG.sendPhoto), json(502, TG.badGateway));
    const res = await adapter().publish(job({ text: "x".repeat(1500), media: [img("cover.png")] }));
    expect(res).toMatchObject({ remoteId: "43", url: "https://t.me/eventx/43" });
    expect(res.note).toBe(
      "The photo was posted, but the text after it may not have been: Telegram: the server answered with an error (HTTP 502) while posting, so it is not known whether it went out.",
    );
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it("sends an album with the caption on the first photo", async () => {
    queue(json(200, TG.sendMediaGroup));
    expect(await adapter().publish(job({ text: "Three photos", media: [img("a.png"), img("b.png"), img("c.png")] }))).toEqual({ remoteId: "44", url: "https://t.me/eventx/44" });
    const parts = formParts(0);
    expect(call(0).url).toBe(`${API}/sendMediaGroup`);
    expect(JSON.parse(parts.media!.value!)).toEqual([
      { type: "photo", media: "attach://photo0", caption: "Three photos", parse_mode: "HTML" },
      { type: "photo", media: "attach://photo1" },
      { type: "photo", media: "attach://photo2" },
    ]);
    expect(Object.keys(parts).sort()).toEqual(["chat_id", "media", "photo0", "photo1", "photo2"]);
  });

  it("waits UPLOAD_TIMEOUT_MS for requests that carry files, the client's timeout for the rest (Task 2 carry)", async () => {
    // The contract client times out after 50 ms; an answer after 120 ms still arrives for a photo, not for a message.
    const late = (f: Fixture): Fixture => (req) => new Promise((resolve) => window.setTimeout(() => resolve(f(req)), 120));
    queue(late(json(200, TG.sendPhoto)), late(json(200, TG.sendMediaGroup)), late(json(200, TG.sendMessage)));
    expect(await adapter().publish(job({ media: [img("cover.png")] }))).toMatchObject({ remoteId: "43" });
    expect(await adapter().publish(job({ media: [img("a.png"), img("b.png")] }))).toMatchObject({ remoteId: "44" });
    await expect(adapter().publish(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("refuses without a token or a chat id, before any request", async () => {
    await expect(adapter().publish(job({ secret: null }))).rejects.toThrow("Add this channel's bot token on this device (Settings → Social Planner → Channels).");
    await expect(adapter().publish(job({}, {}, { handle: "Event X" }))).rejects.toThrow("Set the handle of tg/event-x to the channel's chat id: @name for a public channel, -100… for a private one.");
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("treats a missing chat or missing admin rights as needs-user, and bad markup as invalid content", async () => {
    queue(json(400, TG.chatNotFound), json(400, TG.badEntities));
    await expect(adapter().publish(job())).rejects.toMatchObject({ kind: "needs_user", message: "Telegram: Bad Request: chat not found (HTTP 400)" });
    await expect(adapter().publish(job())).rejects.toMatchObject({ kind: "invalid_content" });
  });

  it("has no hand-over and no lookup: the Bot API can neither schedule nor read a channel's history (Task 3 carry, M5 P2)", () => {
    const a = adapter();
    expect("schedule" in a).toBe(false);
    expect("lookup" in a).toBe(false);
    expect("update" in a).toBe(false);
    expect("cancel" in a).toBe(false);
  });
});

describe("the bot token never reaches a message (M5 G4)", () => {
  // requestUrl's own error can name the URL, and the token is in the URL's path.
  const leaky: Fixture = (req) => new Error(`net::ERR_FAILED ${req.url}`);
  const secretParts = [TG_TOKEN, TG_TOKEN.split(":")[1]!];

  it("keeps it out of publish, verify and findChats errors, even when an error body echoes it", async () => {
    const messages: string[] = [];
    queue(leaky);
    await adapter()
      .publish(job())
      .catch((e: Error) => messages.push(e.message));
    queue(leaky);
    const v = await adapter().verify(job().channel, TG_TOKEN);
    if (!v.ok) messages.push(v.error);
    queue(leaky);
    await adapter()
      .findChats(TG_TOKEN)
      .catch((e: Error) => messages.push(e.message));
    queue(json(401, { ok: false, error_code: 401, description: `Unauthorized for ${API}` }));
    await adapter()
      .findChats(TG_TOKEN)
      .catch((e: Error) => messages.push(e.message));
    expect(requestUrlMock.calls).toHaveLength(4);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toBe("Telegram: Unauthorized for https://api.telegram.org/bot[token] (HTTP 401)");
    for (const m of messages) for (const s of secretParts) expect(m).not.toContain(s);
  });
});

describe("TelegramAdapter.verify and findChats", () => {
  it("checks the token, the chat and the bot's admin rights", async () => {
    queue(json(200, TG.getMe), json(200, TG.getChat), json(200, TG.admin));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: true, account: "Event X, posting as @osmm_bot" });
    expect(sentJson(2)).toEqual({ chat_id: "@eventx", user_id: 123456789 });
    queue(json(200, TG.getMe), json(200, TG.getChat), json(200, TG.member));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: false, error: "The bot is not an admin of Event X. Add it as an administrator with permission to post messages." });
    queue(json(401, TG.unauthorized));
    expect(await adapter().verify(job().channel, TG_TOKEN)).toEqual({ ok: false, error: "Telegram: Unauthorized (HTTP 401)" });
  });

  it("lists the channels the bot has seen, newest first, without duplicates", async () => {
    queue(json(200, TG.getUpdates));
    expect(await adapter().findChats(TG_TOKEN)).toEqual([
      { id: "-1001234567890", title: "Event X", username: "eventx" },
      { id: "-1009876543210", title: "Private news" },
    ]);
    expect(sentJson(0)).toEqual({ allowed_updates: ["channel_post", "my_chat_member"], limit: 100 });
  });

  it("explains a webhook conflict", async () => {
    queue(json(409, TG.webhookConflict));
    await expect(adapter().findChats(TG_TOKEN)).rejects.toThrow("This bot has a webhook, so Telegram won't list its chats here. Enter the chat id by hand (@name or -100…).");
  });
});

async function telegramCtx() {
  const P = "Social/Posts/Tg.md";
  const c = await makeCtx({
    seed: true,
    now: CONTRACT_NOW,
    notes: [{ path: P, frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "scheduled", scheduled_at: "2026-10-08T10:00:00+02:00", deliveries: { "tg/event-x": { status: "scheduled" } } }, body: "Doors open at 18:00" }],
  });
  await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, handle: "@eventx", secretId: "osmm-channel-tg-event-x" });
  c.app.secretStorage.setSecret("osmm-channel-tg-event-x", TG_TOKEN);
  c.adapters.register(new TelegramAdapter(contractDeps()));
  const status = async () => {
    const fm = parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter) as { deliveries: Record<string, { status: string }> };
    return fm.deliveries["tg/event-x"]!.status;
  };
  return { P, c, status };
}

describe("an interrupted Telegram post (review focus 1)", () => {
  it("an unanswered sendMessage parks the delivery on check_needed and never sends twice", async () => {
    const { P, c, status } = await telegramCtx();
    queue(hang);
    expect(await c.ctx.publish.orchestrator.run(P, "tg/event-x")).toEqual({ status: "check_needed" });
    expect(requestUrlMock.calls).toHaveLength(1);
    expect(await status()).toBe("check_needed");
  });

  it("a 502 on sendMessage parks the delivery on check_needed and sends once (M5 P2)", async () => {
    const { P, c, status } = await telegramCtx();
    queue(json(502, TG.badGateway), json(200, TG.sendMessage));
    expect(await c.ctx.publish.orchestrator.run(P, "tg/event-x")).toEqual({ status: "check_needed" });
    expect(await status()).toBe("check_needed");
    // check_needed is not claimable: a second run sends nothing.
    await c.ctx.publish.orchestrator.run(P, "tg/event-x");
    expect(requestUrlMock.calls).toHaveLength(1);
    expect(await status()).toBe("check_needed");
  });
});
