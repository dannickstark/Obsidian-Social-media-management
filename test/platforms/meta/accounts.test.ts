import { describe, expect, it } from "vitest";
import { MetaClient } from "../../../src/platforms/meta/client";
import { obsidianHttp } from "../../../src/platforms/http";
import { call, json, queue } from "../http";

const client = () => new MetaClient({ http: obsidianHttp, now: () => 0 });
const tokens = { accessToken: "USER-TOKEN-12345" };

describe("Meta account discovery", () => {
  it("returns typed Pages with their own tokens across cursored pages", async () => {
    queue(
      json(200, {
        data: [
          {
            id: "11",
            name: "A Page",
            access_token: "PAGE-TOKEN-11",
            tasks: ["CREATE_CONTENT"],
            instagram_business_account: { id: "31" },
          },
        ],
        paging: {
          next: "https://graph.facebook.com/v24.0/me/accounts?after=b",
          cursors: { after: "b" },
        },
      }),
      json(200, {
        data: [
          { id: "12", name: "Another Page", access_token: "PAGE-TOKEN-12", tasks: ["ANALYZE"] },
        ],
      }),
      json(200, {
        data: [{ permission: "instagram_content_publish", status: "granted" }],
      }),
      json(200, { id: "31", username: "studio", account_type: "MEDIA_CREATOR" }),
    );
    const pages = await client().listPages(tokens);
    expect(pages).toEqual([
      {
        id: "11",
        name: "A Page",
        accessToken: "PAGE-TOKEN-11",
        tasks: ["CREATE_CONTENT"],
        instagramBusinessAccountId: "31",
        instagramContentPublishPermission: "granted",
      },
      {
        id: "12",
        name: "Another Page",
        accessToken: "PAGE-TOKEN-12",
        tasks: ["ANALYZE"],
        instagramContentPublishPermission: "granted",
      },
    ]);
    expect(call(0).url).toContain("/me/accounts?");
    expect(call(2).url).toContain("/me/permissions?");
    expect(call(2).headers?.Authorization).toBe(`Bearer ${tokens.accessToken}`);
    expect(await client().listInstagramBusinesses(pages[0]!)).toMatchObject([
      { id: "31", accountType: "MEDIA_CREATOR", capabilities: { imagePublish: true } },
    ]);
  });

  it("rejects a non-Page row rather than treating it as a Page", async () => {
    queue(
      json(200, {
        data: [
          { id: "u1", name: "Person", type: "user", access_token: "USER-TOKEN-12345", tasks: [] },
        ],
      }),
    );
    await expect(client().listPages(tokens)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringMatching(/Page/i),
    });
  });

  it("rejects a Page without a Page access token", async () => {
    queue(json(200, { data: [{ id: "11", name: "A Page", tasks: ["CREATE_CONTENT"] }] }));
    await expect(client().listPages(tokens)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringMatching(/Page access token/i),
    });
  });

  it("returns only connected professional Instagram accounts eligible for image publishing", async () => {
    const page = {
      id: "11",
      name: "A Page",
      accessToken: "PAGE-TOKEN-11",
      tasks: ["CREATE_CONTENT"],
      instagramBusinessAccountId: "31",
      instagramContentPublishPermission: "granted" as const,
    };
    queue(json(200, { id: "31", username: "studio", account_type: "BUSINESS" }));
    expect(await client().listInstagramBusinesses(page)).toEqual([
      {
        id: "31",
        username: "studio",
        accountType: "BUSINESS",
        pageId: "11",
        pageAccessToken: "PAGE-TOKEN-11",
        capabilities: { imagePublish: true },
      },
    ]);
    expect(call(0).url).toContain("/31?");
    expect(call(0).headers?.Authorization).toBe("Bearer PAGE-TOKEN-11");
  });

  it("records a declined publish grant and refuses to advertise image publishing", async () => {
    queue(
      json(200, {
        data: [
          {
            id: "11",
            name: "A",
            access_token: "PAGE-TOKEN-11",
            tasks: ["CREATE_CONTENT"],
            instagram_business_account: { id: "31" },
          },
        ],
      }),
      json(200, { data: [{ permission: "instagram_content_publish", status: "declined" }] }),
      json(200, { id: "31", username: "studio", account_type: "BUSINESS" }),
    );
    const [page] = await client().listPages(tokens);
    expect(page?.instagramContentPublishPermission).toBe("declined");
    await expect(client().listInstagramBusinesses(page!)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringContaining("instagram_content_publish"),
    });
  });

  it("treats an absent publish grant as missing and refuses image publishing", async () => {
    queue(
      json(200, {
        data: [
          {
            id: "11",
            name: "A",
            access_token: "PAGE-TOKEN-11",
            tasks: ["CREATE_CONTENT"],
            instagram_business_account: { id: "31" },
          },
        ],
      }),
      json(200, { data: [{ permission: "instagram_basic", status: "granted" }] }),
      json(200, { id: "31", username: "studio", account_type: "MEDIA_CREATOR" }),
    );
    const [page] = await client().listPages(tokens);
    expect(page?.instagramContentPublishPermission).toBe("missing");
    await expect(client().listInstagramBusinesses(page!)).rejects.toMatchObject({
      kind: "needs_user",
      message: expect.stringContaining("instagram_content_publish"),
    });
  });

  it("omits unconnected, personal, and Pages without CREATE_CONTENT", async () => {
    expect(
      await client().listInstagramBusinesses({
        id: "11",
        name: "A",
        accessToken: "P",
        tasks: ["CREATE_CONTENT"],
        instagramContentPublishPermission: "granted",
      }),
    ).toEqual([]);
    expect(
      await client().listInstagramBusinesses({
        id: "11",
        name: "A",
        accessToken: "P",
        tasks: ["ANALYZE"],
        instagramBusinessAccountId: "31",
        instagramContentPublishPermission: "granted",
      }),
    ).toEqual([]);
    queue(json(200, { id: "31", username: "personal", account_type: "PERSONAL" }));
    expect(
      await client().listInstagramBusinesses({
        id: "11",
        name: "A",
        accessToken: "P",
        tasks: ["CREATE_CONTENT"],
        instagramBusinessAccountId: "31",
        instagramContentPublishPermission: "granted",
      }),
    ).toEqual([]);
  });
});
