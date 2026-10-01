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
    );
    expect(await client().listPages(tokens)).toEqual([
      {
        id: "11",
        name: "A Page",
        accessToken: "PAGE-TOKEN-11",
        tasks: ["CREATE_CONTENT"],
        instagramBusinessAccountId: "31",
      },
      { id: "12", name: "Another Page", accessToken: "PAGE-TOKEN-12", tasks: ["ANALYZE"] },
    ]);
    expect(call(0).url).toContain("/me/accounts?");
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

  it("omits unconnected, personal, and Pages without CREATE_CONTENT", async () => {
    expect(
      await client().listInstagramBusinesses({
        id: "11",
        name: "A",
        accessToken: "P",
        tasks: ["CREATE_CONTENT"],
      }),
    ).toEqual([]);
    expect(
      await client().listInstagramBusinesses({
        id: "11",
        name: "A",
        accessToken: "P",
        tasks: ["ANALYZE"],
        instagramBusinessAccountId: "31",
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
      }),
    ).toEqual([]);
  });
});
