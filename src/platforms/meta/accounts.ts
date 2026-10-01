import { NeedsUserError } from "../errors";
import type { MetaClient } from "./client";

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  instagramBusinessAccountId?: string;
}

export interface InstagramBusiness {
  id: string;
  username: string;
  accountType: "BUSINESS" | "MEDIA_CREATOR";
  pageId: string;
  pageAccessToken: string;
  capabilities: { imagePublish: true };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A user token yields Page tokens through /me/accounts. Never substitute the user token for a missing Page token. */
export async function discoverPages(
  client: MetaClient,
  tokens: { accessToken: string },
): Promise<MetaPage[]> {
  const rows = await client.list("me/accounts", tokens.accessToken, {
    fields: "id,name,access_token,tasks,instagram_business_account",
  });
  return rows.map((row) => {
    const page = object(row);
    if (
      !page ||
      !nonempty(page.id) ||
      !nonempty(page.name) ||
      (page.type !== undefined && page.type !== "page" && page.type !== "PAGE")
    ) {
      throw new NeedsUserError(
        "Meta: account discovery returned a non-Page account; select a Facebook Page.",
      );
    }
    if (!nonempty(page.access_token))
      throw new NeedsUserError(
        "Meta: the Page access token is missing; check Page permissions and provide a token with Page access.",
      );
    if (page.tasks !== undefined && (!Array.isArray(page.tasks) || !page.tasks.every(nonempty)))
      throw new NeedsUserError("Meta: Page tasks were unreadable; try account discovery again.");
    const linked = object(page.instagram_business_account);
    if (page.instagram_business_account != null && !nonempty(linked?.id))
      throw new NeedsUserError(
        "Meta: the linked Instagram account was unreadable; try account discovery again.",
      );
    return {
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      tasks: (page.tasks as string[] | undefined) ?? [],
      ...(linked ? { instagramBusinessAccountId: linked.id as string } : {}),
    };
  });
}

/** Account type and Page task establish eligibility; they do not prove an app permission grant or OAuth connection. */
export async function discoverInstagramBusinesses(
  client: MetaClient,
  page: MetaPage,
): Promise<InstagramBusiness[]> {
  if (!page.instagramBusinessAccountId || !page.tasks.includes("CREATE_CONTENT")) return [];
  const account = object(
    await client.get(page.instagramBusinessAccountId, page.accessToken, {
      fields: "id,username,account_type",
    }),
  );
  if (
    !account ||
    account.id !== page.instagramBusinessAccountId ||
    !nonempty(account.username) ||
    !nonempty(account.account_type)
  ) {
    throw new NeedsUserError(
      "Meta: the linked Instagram account was unreadable; check its Page connection and try again.",
    );
  }
  if (account.account_type !== "BUSINESS" && account.account_type !== "MEDIA_CREATOR") return [];
  return [
    {
      id: account.id,
      username: account.username,
      accountType: account.account_type,
      pageId: page.id,
      pageAccessToken: page.accessToken,
      capabilities: { imagePublish: true },
    },
  ];
}
