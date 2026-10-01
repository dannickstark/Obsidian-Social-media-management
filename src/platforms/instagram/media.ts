import { NeedsUserError } from "../errors";

export interface InstagramHostedFile {
  name: string;
  mime: string;
  data: ArrayBuffer;
}

export interface HostedInstagramMedia {
  url: string;
  /** Unix epoch milliseconds after which the URL can no longer be fetched. */
  expiresAt?: number;
}

/** A host must make image bytes reachable by Meta without exposing vault paths or credentials. */
export interface InstagramMediaHost {
  /** `token` is reserved for a host-specific credential; it is never the Meta account token. */
  create(file: InstagramHostedFile, token: string): Promise<HostedInstagramMedia>;
}

/**
 * M6 currently has no configured public media host. Instagram's Graph API fetches image_url from Meta's servers;
 * a vault resource URL, local listener, or private Obsidian path cannot satisfy that contract safely.
 */
export class AssistedOnlyInstagramMediaHost implements InstagramMediaHost {
  async create(_file: InstagramHostedFile, _token: string): Promise<HostedInstagramMedia> {
    throw new NeedsUserError(
      "Instagram API publishing needs a secure public image host that Meta can fetch. No host is configured; use assisted publishing to add the image in Instagram.",
    );
  }
}

/** Reject local/private destinations and URLs that carry userinfo, query credentials, or fragments. */
export function validateInstagramMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NeedsUserError("Instagram: the image host did not return a valid public URL; use assisted publishing.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let decodedPath = url.pathname;
  let fullyDecoded = false;
  for (let depth = 0; depth < 8; depth++) {
    try {
      // Protect literal percent signs (for example `%25` in an image name) while decoding real escapes.
      const decodablePath = decodedPath.replace(/%(?![0-9a-f]{2})/gi, "%25");
      const next = decodeURIComponent(decodablePath);
      if (next === decodedPath) {
        fullyDecoded = true;
        break;
      }
      decodedPath = next;
    } catch {
      throw new NeedsUserError("Instagram: the image host URL has an invalid path; use assisted publishing.");
    }
  }
  // Don't allow a deeply nested encoding to hide separators or a local path from the checks below.
  if (!fullyDecoded && /%[0-9a-f]{2}/i.test(decodedPath))
    throw new NeedsUserError("Instagram: the image host URL path is too deeply encoded; use assisted publishing.");
  decodedPath = decodedPath.replace(/\\/g, "/");
  const localPath =
    /(?:^|\/)users\/[^/]+(?:\/|$)/i.test(decodedPath) ||
    /(?:^|\/)home\/[^/]+(?:\/|$)/i.test(decodedPath) ||
    /(?:^|\/)(?:private\/)?(?:tmp|var)(?:\/|$)/i.test(decodedPath) ||
    /(?:^|\/)\.obsidian(?:\/|$)/i.test(decodedPath) ||
    /(?:^|\/)vault(?:\/|$)/i.test(decodedPath);
  const ipv4 = host.split(".").map(Number);
  const privateIpv4 =
    ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168));
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || privateIpv4;
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    privateHost ||
    localPath
  ) {
    throw new NeedsUserError(
      "Instagram: the image host URL must be public HTTPS and contain no credentials or private path; use assisted publishing.",
    );
  }
  return url.toString();
}
