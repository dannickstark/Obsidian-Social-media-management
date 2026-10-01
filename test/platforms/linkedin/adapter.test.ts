import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdapters } from "../../../src/platforms/adapters";
import { effectiveMethod } from "../../../src/platforms/registry";
import { NeedsUserError } from "../../../src/platforms/errors";
import { requestUrlMock } from "../../fakes/obsidian";
import { contractDeps, CONTRACT_NOW } from "../contract/harness";
import { img, channel } from "../fixtures";
import { call, json, netError, queue, sentJson } from "../http";
import type { DeliveryJob } from "../../../src/platforms/types";

const token = "LINKEDIN-ACCESS-SECRET";
function job(kind: "profile" | "page" = "profile"): DeliveryJob {
  return {
    variant: { path: "Social/Posts/LinkedIn.md", platform: "linkedin", channels: ["li/me"], mode: "auto", status: "scheduled", media: [], deliveries: {} },
    channel: channel("li/me", { kind, handle: kind === "profile" ? "urn:li:person:abc123" : "urn:li:organization:987", method: "api" }),
    delivery: { status: "publishing", at: CONTRACT_NOW, attempts: 1, sendAt: CONTRACT_NOW, sendKey: "li-send-key" },
    text: "Hello LinkedIn", items: ["Hello LinkedIn"], body: "Hello LinkedIn", media: [], secret: token,
  };
}
function adapter(overrides: { member?: boolean; community?: boolean } = {}) {
  return createAdapters({ ...contractDeps(), linkedInMemberAccessVerified: overrides.member ?? true, linkedInCommunityManagementAccessVerified: overrides.community ?? false }).find((a) => a.platform === "linkedin")!;
}

describe("LinkedIn posts", () => {
  beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout }));
  afterEach(() => requestUrlMock.reset());

  it("refuses organization publishing until Community Management access is verified", async () => {
    await expect(adapter().publish!(job("page"))).rejects.toBeInstanceOf(NeedsUserError);
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("routes unverified profile and organization channels through the assisted flow", () => {
    const gated = adapter({ member: false });
    expect(effectiveMethod("auto", job().channel, gated)).toBe("assisted");
    expect(effectiveMethod("auto", job("page").channel, gated)).toBe("assisted");
  });

  it("publishes member text through Posts API with verified member access", async () => {
    queue(json(201, {}, { "x-restli-id": "urn:li:share:44" }));
    const result = await adapter().publish!(job());
    expect(result).toEqual({ remoteId: "urn:li:share:44", url: "https://www.linkedin.com/feed/update/urn:li:share:44" });
    expect(call(0).url).toBe("https://api.linkedin.com/rest/posts");
    expect(call(0).headers?.Authorization).toBe(`Bearer ${token}`);
    expect(call(0).headers?.["Linkedin-Version"]).toBeTypeOf("string");
    expect(sentJson(0)).toMatchObject({ author: "urn:li:person:abc123", commentary: "Hello LinkedIn", visibility: "PUBLIC" });
  });

  it("uploads an image before creating a post", async () => {
    queue(
      json(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/image/1/uploaded-image/0?ut=upload-token", image: "urn:li:image:abc" } }),
      json(201, {}),
      json(201, {}, { "x-restli-id": "urn:li:share:45" }),
    );
    await adapter().publish!({ ...job(), media: [img()] });
    expect(call(0).url).toContain("/rest/images?action=initializeUpload");
    expect(call(1).url).toBe("https://www.linkedin.com/dms-uploads/image/1/uploaded-image/0?ut=upload-token");
    expect(call(1).method).toBe("PUT");
    expect(sentJson(2)).toMatchObject({ content: { media: { id: "urn:li:image:abc" } } });
  });

  it("uploads each image before publishing them as one organic multi-image post", async () => {
    queue(
      json(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/image/1/uploaded-image/0?ut=1", image: "urn:li:image:first" } }),
      json(201, {}),
      json(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/image/2/uploaded-image/0?ut=2", image: "urn:li:image:second" } }),
      json(201, {}),
      json(201, {}, { "x-restli-id": "urn:li:share:46" }),
    );
    await adapter().publish!({ ...job(), media: [img("first.png"), img("second.png")] });
    expect(call(4).url).toBe("https://api.linkedin.com/rest/posts");
    expect(sentJson(4)).toMatchObject({
      content: { multiImage: { images: [
        { id: "urn:li:image:first", altText: "An image" },
        { id: "urn:li:image:second", altText: "An image" },
      ] } },
    });
  });

  it.each([json(201, {}), json(200, { id: "bad-id" })])("treats an unreadable commit response as unknown", async (answer) => {
    queue(answer);
    await expect(adapter().publish!(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("classifies rate limits as transient and honors Retry-After", async () => {
    queue(json(429, { message: "rate limit" }, { "Retry-After": "17" }));
    await expect(adapter().publish!(job())).rejects.toMatchObject({ kind: "transient", retryAfterMs: 17_000 });
  });

  it("treats a lost connection during post creation as an unknown outcome", async () => {
    queue(netError);
    await expect(adapter().publish!(job())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("requires verified member product access and redacts the token from errors", async () => {
    await expect(adapter({ member: false }).publish!(job())).rejects.toThrow(/w_member_social.*assisted/i);
    queue(json(403, { message: `denied ${token}` }));
    await expect(adapter().publish!(job())).rejects.not.toThrow(token);
  });

  it("publishes to an organization only when both access checks are enabled", async () => {
    queue(
      json(200, { sub: "abc123", name: "Ada Lovelace" }),
      json(200, { elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:987", "organization~": { id: 987, localizedName: "Analytical Engines" } }] }),
      json(201, {}, { "x-restli-id": "urn:li:share:55" }),
    );
    await adapter({ community: true }).publish!(job("page"));
    expect(sentJson(2)).toMatchObject({ author: "urn:li:organization:987" });
  });

  it("refuses an organization when the authenticated member lacks an approved publishing role", async () => {
    queue(
      json(200, { sub: "abc123", name: "Ada Lovelace" }),
      json(200, { elements: [{ role: "ANALYST", state: "APPROVED", organization: "urn:li:organization:987", "organization~": { id: 987, localizedName: "Analytical Engines" } }] }),
    );
    await expect(adapter({ community: true }).publish!(job("page"))).rejects.toThrow(/not confirmed as available for publishing/i);
    expect(requestUrlMock.calls).toHaveLength(2);
  });
});
