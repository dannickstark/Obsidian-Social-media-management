import { tid } from "../../../src/platforms/bluesky/tid";
import { CONTRACT_NOW } from "../contract/harness";

export const BS_PASSWORD = "abcd-efgh-ijkl-mnop";
export const BS_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const BS_PDS = "https://morel.us-east.host.bsky.network";
export const BS_ACCESS = "eyJhbGciOiJFUzI1NksifQ.YWNjZXNz.c2lnbmF0dXJlLWFjY2Vzcw";
export const BS_REFRESH = "eyJhbGciOiJFUzI1NksifQ.cmVmcmVzaA.c2lnbmF0dXJlLXJlZnJlc2g";
/** The contract job's send key (M5 P17b): the claim's TID with a random offset and clock id; part 0's record key. */
export const RKEY0 = tid(CONTRACT_NOW * 1000 + 417, 733);
export const uriOf = (rkey: string): string => `at://${BS_DID}/app.bsky.feed.post/${rkey}`;

const didDoc = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  id: BS_DID,
  alsoKnownAs: ["at://you.bsky.social"],
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: BS_PDS }],
};

export const BS = {
  /** com.atproto.server.createSession */
  session: { did: BS_DID, didDoc, handle: "you.bsky.social", email: "you@example.com", emailConfirmed: true, accessJwt: BS_ACCESS, refreshJwt: BS_REFRESH, active: true },
  /** com.atproto.server.refreshSession */
  refreshed: { did: BS_DID, didDoc, handle: "you.bsky.social", accessJwt: "eyJhbGciOiJFUzI1NksifQ.bmV3.YWNjZXNzMg", refreshJwt: "eyJhbGciOiJFUzI1NksifQ.bmV3.cmVmcmVzaDI", active: true },
  /** com.atproto.repo.createRecord */
  created: (rkey: string) => ({ uri: uriOf(rkey), cid: "bafyreihzyk4ehbxt6k3fmrk2fyrx3uxcg5nyq4cxqvxhz7tzm6cy4vudcq", commit: { cid: "bafyreicommit", rev: "3l5abc2def" }, validationStatus: "valid" }),
  /** com.atproto.repo.uploadBlob */
  blob: { blob: { $type: "blob", ref: { $link: "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy" }, mimeType: "image/png", size: 8 } },
  /** com.atproto.identity.resolveHandle */
  resolved: { did: "did:plc:alice" },
  unresolved: { error: "InvalidRequest", message: "Unable to resolve handle" },
  /** com.atproto.repo.getRecord */
  record: (rkey: string, text = "Doors open at 18:00") => ({ uri: uriOf(rkey), cid: "bafyreirecord", value: { $type: "app.bsky.feed.post", text, createdAt: new Date(CONTRACT_NOW).toISOString() } }),
  notFound: { error: "RecordNotFound", message: `Could not locate record: ${uriOf(RKEY0)}` },
  expired: { error: "ExpiredToken", message: "Token has expired" },
  badLogin: { error: "AuthenticationRequired", message: "Invalid identifier or password" },
  takedown: { error: "AccountTakedown", message: "Account has been taken down" },
  rateLimited: { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
  invalid: { error: "InvalidRequest", message: "Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes" },
  upstream: { error: "UpstreamFailure", message: "Upstream Failure" },
};

/** The PDS's rate-limit headers; ratelimit-reset is in epoch seconds. */
export const RATE_HEADERS = { "ratelimit-limit": "5000", "ratelimit-remaining": "0", "ratelimit-reset": String(CONTRACT_NOW / 1000 + 30), "ratelimit-policy": "5000;w=3600" };
