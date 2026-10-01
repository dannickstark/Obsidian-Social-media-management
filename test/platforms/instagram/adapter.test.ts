import { afterEach, describe, expect, it } from "vitest";
import { channel, img } from "../fixtures";
import { requestUrlMock } from "../../fakes/obsidian";
import { obsidianHttp } from "../../../src/platforms/http";
import { InstagramAdapter } from "../../../src/platforms/instagram/api";
import type { InstagramMediaHost } from "../../../src/platforms/instagram/media";
import type { AdapterDeps } from "../../../src/platforms/adapters";
import type { DeliveryJob } from "../../../src/platforms/types";
import { CONTRACT_NOW } from "../contract/harness";
import { json, queue, sentText } from "../http";

const sentForm = (index: number): Record<string, string> => Object.fromEntries(new URLSearchParams(sentText(index)));

const USER_TOKEN = "IG-USER-SECRET";
const PAGE_TOKEN = "IG-PAGE-SECRET";
const IG_ID = "123456789";
const PAGE_ID = "987654321";
const mediaUrl = (id: string) => `https://cdn.example.net/${id}`;
const deps = (): AdapterDeps => ({
  http: obsidianHttp,
  now: () => CONTRACT_NOW,
  readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
  sleep: async () => undefined,
  timeoutMs: 50,
});
const host = (): InstagramMediaHost => ({
  create: async (file, token) => {
    expect(token).toBe("");
    return { url: mediaUrl(file.name) };
  },
});
const before = (permission = "granted") => [
  json(200, {
    data: [
      {
        id: PAGE_ID,
        name: "Studio",
        access_token: PAGE_TOKEN,
        tasks: ["CREATE_CONTENT"],
        instagram_business_account: { id: IG_ID },
      },
    ],
  }),
  json(200, { data: [{ permission: "instagram_content_publish", status: permission }] }),
  json(200, { id: IG_ID, username: "studio", account_type: "BUSINESS" }),
];
const job = (media = [img()]): DeliveryJob => ({
  variant: {
    path: "Social/Posts/Instagram.md",
    platform: "instagram",
    channels: ["ig/studio"],
    mode: "auto",
    status: "scheduled",
    media: media.map((m) => m.target),
    deliveries: {},
  },
  channel: channel("ig/studio", {
    kind: "profile",
    handle: IG_ID,
    method: "api",
    secretId: "ig-token",
  }),
  delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1 },
  text: "A caption",
  items: ["A caption"],
  body: "A caption",
  media,
  secret: USER_TOKEN,
});
const adapter = (mediaHost = host()) =>
  new InstagramAdapter(deps(), mediaHost);

afterEach(() => requestUrlMock.reset());

describe("Instagram Business image publishing", () => {
  it("requires a confirmed instagram_content_publish permission before advertising a publisher", async () => {
    queue(...before("declined"));
    const result = await adapter().verify(job().channel, USER_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("instagram_content_publish");
  });

  it("publishes a single image through a ready media container", async () => {
    queue(
      ...before(),
      json(200, { id: "101" }),
      json(200, { id: "101", status_code: "FINISHED" }),
      json(200, { id: "201" }),
      json(200, { id: "201", permalink: "https://www.instagram.com/p/Cabc123/", media_type: "IMAGE", username: "studio" }),
    );
    const result = await adapter().publish!(job());
    expect(result).toEqual({ remoteId: "201", url: "https://www.instagram.com/p/Cabc123/" });
    expect(sentForm(3)).toEqual({ image_url: mediaUrl("a.png"), caption: "A caption" });
    expect(requestUrlMock.calls[5]?.url).toContain(`/${IG_ID}/media_publish`);
  });

  it("keeps carousel items in the note's media order", async () => {
    queue(
      ...before(),
      json(200, { id: "101" }),
      json(200, { id: "101", status_code: "FINISHED" }),
      json(200, { id: "102" }),
      json(200, { id: "102", status_code: "FINISHED" }),
      json(200, { id: "103" }),
      json(200, { id: "103", status_code: "FINISHED" }),
      json(200, { id: "201" }),
      json(200, { id: "201", permalink: "https://www.instagram.com/p/Cdef456/", media_type: "CAROUSEL_ALBUM", username: "studio" }),
    );
    await adapter().publish!(job([img("first.png"), img("second.png")]));
    expect(sentForm(3)).toEqual({ image_url: mediaUrl("first.png"), is_carousel_item: "true" });
    expect(sentForm(5)).toEqual({ image_url: mediaUrl("second.png"), is_carousel_item: "true" });
    expect(sentForm(7)).toEqual({ media_type: "CAROUSEL", children: "101,102", caption: "A caption" });
  });

  it("polls processing containers until they finish", async () => {
    queue(
      ...before(),
      json(200, { id: "101" }),
      json(200, { id: "101", status_code: "IN_PROGRESS" }),
      json(200, { id: "101", status_code: "FINISHED" }),
      json(200, { id: "201" }),
      json(200, { id: "201", permalink: "https://www.instagram.com/p/Cghi789/", media_type: "IMAGE", username: "studio" }),
    );
    let waits = 0;
    const a = new InstagramAdapter({ ...deps(), sleep: async () => { waits++; } }, host());
    await a.publish!(job());
    expect(waits).toBe(1);
  });

  it("refuses expired hosted URLs before creating a container", async () => {
    queue(...before());
    const expired = { create: async () => ({ url: mediaUrl("expired"), expiresAt: CONTRACT_NOW }) };
    await expect(adapter(expired).publish!(job())).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls).toHaveLength(3);
  });

  it("refuses video and malformed media before publishing", async () => {
    queue(...before());
    await expect(adapter().publish!(job([img("clip.mp4", 1080, 1350, { kind: "video" })]))).rejects.toMatchObject({ kind: "invalid_content" });
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("parks an unreadable publish answer as an unknown outcome", async () => {
    queue(
      ...before(),
      json(200, { id: "101" }),
      json(200, { id: "101", status_code: "FINISHED" }),
      json(200, {}),
    );
    await expect(adapter().publish!(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("keeps post lookup unknown when Graph cannot confirm the exact media", async () => {
    const j = job();
    j.delivery.remoteId = "201";
    queue(...before(), json(200, { id: "202", permalink: "https://www.instagram.com/p/Cother/" }));
    expect(await adapter().lookup!(j)).toBeNull();
  });

  it("updates a confirmed image caption and refuses media owned by another account", async () => {
    const j = job();
    j.delivery.remoteId = "201";
    queue(
      ...before(),
      json(200, { id: "201", permalink: "https://www.instagram.com/p/Cabc123/", media_type: "IMAGE", username: "studio" }),
      json(200, { success: true }),
    );
    await adapter().update!(j, { content: true, time: false });
    expect(sentForm(4)).toEqual({ caption: "A caption" });
    requestUrlMock.reset();
    queue(
      ...before(),
      json(200, { id: "201", permalink: "https://www.instagram.com/p/Cabc123/", media_type: "IMAGE", username: "someone-else" }),
    );
    await expect(adapter().update!(j, { content: true, time: false })).rejects.toMatchObject({ kind: "needs_user" });
    expect(requestUrlMock.calls.some((request) => request.method === "POST" && request.url.endsWith("/201"))).toBe(false);
  });
});
