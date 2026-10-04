import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLinkedInAccounts } from "../../../src/platforms/linkedin/accounts";
import { requestUrlMock } from "../../fakes/obsidian";
import { call, json, queue } from "../http";
import { contractDeps } from "../contract/harness";

describe("LinkedIn account discovery", () => {
  beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout }));
  afterEach(() => requestUrlMock.reset());

  it("discovers the authenticated member and reports its required permission", async () => {
    queue(json(200, { sub: "abc123", name: "Ada Lovelace", picture: "https://example.com/a.png" }));
    const accounts = await listLinkedInAccounts({ accessToken: "LINKEDIN-TOKEN", grantedScopes: ["openid", "profile", "w_member_social"], signInWithLinkedInProductVerified: true }, contractDeps());
    expect(accounts).toEqual([{ id: "urn:li:person:abc123", kind: "profile", name: "Ada Lovelace", requiredPermission: "w_member_social", permissionStatus: "granted", canPublish: true }]);
    expect(call(0).url).toBe("https://api.linkedin.com/v2/userinfo");
    expect(call(0).headers?.Authorization).toBe("Bearer LINKEDIN-TOKEN");
  });

  it("reports missing member permission without claiming the profile is publishable", async () => {
    queue(json(200, { sub: "abc123", name: "Ada Lovelace" }));
    const accounts = await listLinkedInAccounts({ accessToken: "TOKEN", grantedScopes: ["openid", "profile"], signInWithLinkedInProductVerified: true }, contractDeps());
    expect(accounts[0]).toMatchObject({ kind: "profile", permissionStatus: "missing", canPublish: false });
  });

  it("discovers approved organizations and keeps Community Management access explicitly gated", async () => {
    queue(
      json(200, { sub: "abc123", name: "Ada Lovelace" }),
      json(200, { elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:987", "organization~": { id: 987, localizedName: "Analytical Engines" } }] }),
    );
    const accounts = await listLinkedInAccounts({
      accessToken: "TOKEN",
      grantedScopes: ["openid", "profile", "r_organization_admin", "w_organization_social"],
      signInWithLinkedInProductVerified: true,
    }, contractDeps());
    expect(accounts[1]).toMatchObject({
      id: "urn:li:organization:987",
      kind: "page",
      name: "Analytical Engines",
      requiredPermission: "w_organization_social",
      permissionStatus: "unverified",
      canPublish: false,
    });
    expect(call(1).url).toContain("/rest/organizationAcls?");
  });

  it("requires the separate Sign In with LinkedIn product and OIDC scopes before userinfo discovery", async () => {
    await expect(listLinkedInAccounts({ accessToken: "TOKEN", grantedScopes: ["w_member_social"] }, contractDeps())).rejects.toThrow(/Sign In with LinkedIn.*openid.*profile/i);
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("paginates the organization ACL finder", async () => {
    queue(
      json(200, { sub: "abc123", name: "Ada Lovelace" }),
      json(200, {
        elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:987", "organization~": { id: 987, localizedName: "Analytical Engines" } }],
        paging: { start: 0, count: 100, links: [{ rel: "next", href: "/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=100" }] },
      }),
      json(200, {
        elements: [{ role: "CONTENT_ADMIN", state: "APPROVED", organization: "urn:li:organization:654", "organization~": { id: 654, localizedName: "Difference Engine" } }],
        paging: { start: 100, count: 100, links: [] },
      }),
    );
    const accounts = await listLinkedInAccounts({
      accessToken: "TOKEN",
      grantedScopes: ["openid", "profile", "r_organization_admin", "w_organization_social"],
      signInWithLinkedInProductVerified: true,
    }, contractDeps());
    expect(accounts.map((account) => account.id)).toEqual(["urn:li:person:abc123", "urn:li:organization:987", "urn:li:organization:654"]);
    expect(call(1).url).toContain("count=100");
    expect(call(2).url).toContain("start=100");
  });

  it("rejects malformed identity responses without exposing the access token", async () => {
    queue(json(200, { name: "Ada Lovelace" }));
    await expect(listLinkedInAccounts({ accessToken: "SENSITIVE", grantedScopes: ["openid", "profile"], signInWithLinkedInProductVerified: true }, contractDeps())).rejects.toThrow(/LinkedIn.*identity/i);
    expect(requestUrlMock.calls[0]?.url).not.toContain("SENSITIVE");
  });
});
