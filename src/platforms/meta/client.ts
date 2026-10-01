import { NeedsUserError } from "../errors";
import { ApiClient, parseJson, type ApiFailure, type HttpFn, type HttpResponse } from "../http";
import {
  discoverInstagramBusinesses,
  discoverPages,
  type InstagramBusiness,
  type MetaPage,
} from "./accounts";

const GRAPH_ROOT = "https://graph.facebook.com/v24.0/";
const MAX_PAGES = 10;

export interface MetaClientOptions {
  http: HttpFn;
  now(): number;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redact(message: string, token: string): string {
  let safe = message;
  for (const candidate of [token, encodeURIComponent(token)]) {
    if (candidate) safe = safe.split(candidate).join("[secret]");
  }
  return safe;
}

function metaFailure(res: HttpResponse, token: string): ApiFailure {
  const error = object(object(parseJson(res.text))?.error);
  const code = error?.code;
  if (code === 190)
    return {
      kind: "needs_user",
      message: "the access token expired or is invalid; provide a new token",
    };
  if (code === 10 || code === 200 || code === 2500)
    return {
      kind: "needs_user",
      message:
        "required Page or Instagram permission is missing; grant it in Meta and provide a token with that permission",
    };
  const raw =
    typeof error?.message === "string" ? error.message : "the server answered with an error";
  return { message: redact(raw, token) };
}

export class MetaClient {
  constructor(private readonly options: MetaClientOptions) {}

  private api(token: string): ApiClient {
    return new ApiClient({
      platform: "facebook",
      ...this.options,
      failure: (res) => metaFailure(res, token),
    });
  }

  private url(path: string, query: Record<string, string>): string {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path))
      throw new NeedsUserError("Meta: invalid Graph path; nothing was sent.");
    const url = new URL(path, GRAPH_ROOT);
    for (const [key, value] of Object.entries(query)) {
      if (key.toLowerCase() === "access_token")
        throw new NeedsUserError(
          "Meta: put access tokens in the authorization header; nothing was sent.",
        );
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async get(path: string, token: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!token.trim())
      throw new NeedsUserError("Meta: provide an access token before discovering accounts.");
    const res = await this.api(token).prepare({
      url: this.url(path, query),
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = parseJson(res.text);
    if (!object(body))
      throw new NeedsUserError(
        "Meta: the Graph response was unreadable; try account discovery again.",
      );
    return body;
  }

  /** Follow only the cursor from Graph's next link; never send a token or other query values from that link. */
  async list(
    path: string,
    token: string,
    query: Record<string, string> = {},
    maxPages = MAX_PAGES,
  ): Promise<unknown[]> {
    const limit = Math.min(MAX_PAGES, maxPages);
    if (!Number.isInteger(limit) || limit < 1)
      throw new NeedsUserError("Meta: account discovery needs a positive page limit.");
    const base = new URL(this.url(path, query));
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < limit; page++) {
      const body = object(await this.get(path, token, { ...query, ...(after ? { after } : {}) }));
      if (!Array.isArray(body?.data))
        throw new NeedsUserError(
          "Meta: the account list was unreadable; try account discovery again.",
        );
      rows.push(...body.data);
      const paging = object(body.paging);
      if (paging?.next === undefined || paging.next === null) return rows;
      if (typeof paging.next !== "string")
        throw new NeedsUserError("Meta: the account paging information was unreadable.");
      let next: URL;
      try {
        next = new URL(paging.next);
      } catch {
        throw new NeedsUserError("Meta: the account paging information was unreadable.");
      }
      if (next.origin !== base.origin || next.pathname !== base.pathname)
        throw new NeedsUserError(
          "Meta: the account paging address was unexpected; discovery stopped.",
        );
      const cursor = next.searchParams.get("after");
      if (!cursor || seen.has(cursor))
        throw new NeedsUserError(
          "Meta: the account paging cursor was missing or repeated; discovery stopped.",
        );
      if (page + 1 === limit)
        throw new NeedsUserError(
          "Meta: account discovery exceeded its page limit; narrow the account list and try again.",
        );
      seen.add(cursor);
      after = cursor;
    }
    return rows;
  }

  listPages(tokens: { accessToken: string }): Promise<MetaPage[]> {
    return discoverPages(this, tokens);
  }

  listInstagramBusinesses(page: MetaPage): Promise<InstagramBusiness[]> {
    return discoverInstagramBusinesses(this, page);
  }
}
