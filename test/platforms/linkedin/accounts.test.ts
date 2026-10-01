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
    const accounts = await listLinkedInAccounts({ accessToken: "LINKEDIN-TOKEN", grantedScopes: ["openid", "profile", "w_member_social"] }, contractDeps());
    expect(accounts).toEqual([{ id: "urn:li:person:abc123", kind: "profile", name: "Ada Lovelace", requiredPermission: "w_member_social", permissionStatus: "granted", canPublish: true }]);
    expect(call(0).url).toBe("https://api.linkedin.com/v2/userinfo");
    expect(call(0).headers?.Authorization).toBe("Bearer LINKEDIN-TOKEN");
  });

  it("reports missing member permission without claiming the profile is publishable", async () => {
    queue(json(200, { sub: "abc123", name: "Ada Lovelace" }));
    const accounts = await listLinkedInAccounts({ accessToken: "TOKEN", grantedScopes: ["openid", "profile"] }, contractDeps());
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

  it("rejects malformed identity responses without exposing the access token", async () => {
    queue(json(200, { name: "Ada Lovelace" }));
    await expect(listLinkedInAccounts({ accessToken: "SENSITIVE" }, contractDeps())).rejects.toThrow(/LinkedIn.*identity/i);
    expect(requestUrlMock.calls[0]?.url).not.toContain("SENSITIVE");
  });
});
