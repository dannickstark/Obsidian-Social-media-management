import { NeedsUserError } from "../errors";
import { ApiClient, obsidianHttp, parseJson, type HttpFn, type HttpResponse } from "../http";

export const LINKEDIN_API = "https://api.linkedin.com";
export const LINKEDIN_VERSION = "202608";

export interface LinkedInTokens {
  accessToken: string;
  /** Scopes confirmed by the credential issuer. LinkedIn does not expose these through userinfo. */
  grantedScopes?: readonly string[];
  /** Community Management product access must be confirmed separately for this app. */
  communityManagementAccessVerified?: boolean;
}

export type LinkedInAccountChoice = {
  id: string;
  kind: "profile" | "page";
  name: string;
  requiredPermission: "w_member_social" | "w_organization_social";
  permissionStatus: "granted" | "missing" | "unverified";
  canPublish: boolean;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeError(res: HttpResponse, token: string): { message: string; kind?: "transient" | "needs_user" } {
  const body = object(parseJson(res.text));
  const raw = typeof body?.message === "string" ? body.message : typeof body?.error_description === "string" ? body.error_description : `HTTP ${res.status}`;
  const message = raw.split(token).join("[secret]").split(encodeURIComponent(token)).join("[secret]");
  if (res.status === 429) return { message: "LinkedIn request limit reached; try again later.", kind: "transient" };
  if (res.status === 401 || res.status === 403) return { message: "LinkedIn access is missing or expired; check the granted product permissions or use assisted publishing.", kind: "needs_user" };
  return { message: `LinkedIn: ${message}` };
}

/** Account discovery for an externally obtained LinkedIn user token; no OAuth exchange is performed here. */
export async function listLinkedInAccounts(
  tokens: LinkedInTokens,
  options: { http?: HttpFn; now?: () => number; timeoutMs?: number } = {},
): Promise<LinkedInAccountChoice[]> {
  const token = tokens.accessToken.trim();
  if (!token) throw new NeedsUserError("LinkedIn: add an access token on this device, or use assisted publishing.");
  const api = new ApiClient({
    platform: "linkedin",
    http: options.http ?? obsidianHttp,
    now: options.now ?? Date.now,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    failure: (res) => safeError(res, token),
  });
  const response = await api.prepare({
    url: `${LINKEDIN_API}/v2/userinfo`,
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const member = object(parseJson(response.text));
  if (typeof member?.sub !== "string" || !member.sub.trim())
    throw new NeedsUserError("LinkedIn: identity response was unreadable; check the token or use assisted publishing.");
  const name = [member.given_name, member.family_name].filter((part): part is string => typeof part === "string" && !!part.trim()).join(" ") || (typeof member.name === "string" ? member.name : "LinkedIn member");
  const memberGranted = tokens.grantedScopes?.includes("w_member_social") === true;
  const accounts: LinkedInAccountChoice[] = [{
    id: `urn:li:person:${member.sub}`,
    kind: "profile",
    name,
    requiredPermission: "w_member_social",
    permissionStatus: tokens.grantedScopes ? (memberGranted ? "granted" : "missing") : "unverified",
    canPublish: memberGranted,
  }];

  if (tokens.grantedScopes?.includes("r_organization_admin")) {
    const orgs = await api.prepare({
      url: `${LINKEDIN_API}/rest/organizationAcls?q=roleAssignee&state=APPROVED&projection=(elements*(organization,organizationTarget,role,state,organization~(id,name,localizedName)))`,
      method: "GET",
      headers: linkedInHeaders(token),
    });
    const data = object(parseJson(orgs.text));
    if (!Array.isArray(data?.elements)) throw new NeedsUserError("LinkedIn: organization list was unreadable; try discovery again.");
    for (const rowValue of data.elements) {
      const row = object(rowValue);
      if (row?.state !== "APPROVED" || !["ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER", "CONTENT_ADMIN"].includes(String(row.role))) continue;
      const organization = object(row?.["organization~"]);
      const urn = row.organization ?? row.organizationTarget;
      const id = organization?.id ?? (typeof urn === "string" ? /^urn:li:organization:(\d+)$/.exec(urn)?.[1] : undefined);
      const orgName = organization?.localizedName ?? organization?.name;
      if (!((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && /^\d+$/.test(id))) || typeof orgName !== "string")
        throw new NeedsUserError("LinkedIn: an organization entry was unreadable; try discovery again.");
      const hasScope = tokens.grantedScopes.includes("w_organization_social");
      const productVerified = tokens.communityManagementAccessVerified === true;
      const choiceId = `urn:li:organization:${id}`;
      if (accounts.some((account) => account.id === choiceId)) continue;
      accounts.push({
        id: choiceId,
        kind: "page",
        name: orgName,
        requiredPermission: "w_organization_social",
        permissionStatus: !hasScope ? "missing" : productVerified ? "granted" : "unverified",
        canPublish: hasScope && productVerified,
      });
    }
  }
  return accounts;
}

export function linkedInHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Linkedin-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}
