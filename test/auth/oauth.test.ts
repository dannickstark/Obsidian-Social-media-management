import { createServer, request, type Server } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OAuthFlow, postTokenNoFollow, type TokenRequest } from "../../src/auth/oauth";
import { createPkce, equalState } from "../../src/auth/pkce";
import { SecretIds, Secrets, allSecretIds } from "../../src/secrets/secrets";
import { CredentialHealthStore, loadDeviceSettings } from "../../src/settings/device";
import { createApp } from "../helpers";

const config = {
  provider: "example", clientId: "public-client", authorizeUrl: "https://login.example.test/authorize",
  tokenUrl: "https://login.example.test/token", scopes: ["post", "offline"],
};

function get(url: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: host ? { Host: host } : undefined, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function callback(authorizeUrl: string, fields: Record<string, string>): string {
  const auth = new URL(authorizeUrl);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  return url.href;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("desktop OAuth", () => {
  it("generates a fresh RFC 7636 verifier and matching S256 challenge", async () => {
    const first = await createPkce();
    const second = await createPkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toBe(createHash("sha256").update(first.verifier).digest("base64url"));
  });

  it("compares states exactly", () => {
    expect(equalState("abc", "abc")).toBe(true);
    expect(equalState("abc", "abd")).toBe(false);
    expect(equalState("abc", "ab")).toBe(false);
  });

  it("exchanges a one-shot loopback callback with PKCE and parses tokens", async () => {
    let secondStatus = 0;
    let exchange: TokenRequest | undefined;
    const flow = new OAuthFlow({
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state")!;
        expect(await get(callback(url, { state, code: "one-use-code" }))).toBe(200);
        secondStatus = await get(callback(url, { state, code: "replay" }));
      },
      requestToken: async (req) => {
        exchange = req;
        return { status: 200, text: JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: "post offline" }) };
      },
    });
    const tokens = await flow.start(config);
    expect(secondStatus).toBe(410);
    expect(tokens.accessToken).toBe("access-secret");
    expect(tokens.refreshToken).toBe("refresh-secret");
    expect(tokens.scope).toBe("post offline");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(exchange?.url).toBe(config.tokenUrl);
    const body = new URLSearchParams(exchange?.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("one-use-code");
    expect(body.get("client_id")).toBe(config.clientId);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(exchange?.body ? body.get("redirect_uri")! : "").hostname).toBe("127.0.0.1");
    expect(body.has("client_secret")).toBe(false);
  });

  it("uses the configured callback path in authorization, listener validation, and token exchange", async () => {
    let tokenRedirect = "";
    const flow = new OAuthFlow({
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state")!;
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
        expect(redirect.pathname).toBe("/redirect");
        const wrongPath = new URL(callback(url, { state, code: "wrong-path-code" }));
        wrongPath.pathname = "/callback";
        expect(await get(wrongPath.href)).toBe(404);
        expect(await get(callback(url, { state, code: "right-path-code" }))).toBe(200);
      },
      requestToken: async (req) => {
        tokenRedirect = new URLSearchParams(req.body).get("redirect_uri")!;
        return { status: 200, text: '{"access_token":"token"}' };
      },
    });
    await flow.start({ ...config, redirectPath: "/redirect" });
    expect(new URL(tokenRedirect).pathname).toBe("/redirect");
  });

  it.each(["//evil.example", "/redirect?code=x", "/a/../redirect", "https://evil.example/redirect"])(
    "rejects unsafe callback path %s before opening a browser", async (redirectPath) => {
      const flow = new OAuthFlow({ openBrowser: () => { throw new Error("browser should stay closed"); } });
      await expect(flow.start({ ...config, redirectPath })).rejects.toThrow(/redirect path/i);
    },
  );

  it.each([307, 308])("does not follow a %i token redirect or send the authorization code to its target", async (status) => {
    let forwarded = 0;
    const target = createServer((_req, res) => { forwarded++; res.writeHead(200).end('{"access_token":"stolen"}'); });
    const targetPort = await listen(target);
    const source = createServer((req, res) => {
      req.resume();
      res.writeHead(status, { Location: `http://127.0.0.1:${targetPort}/steal` }).end();
    });
    const sourcePort = await listen(source);
    try {
      await expect(postTokenNoFollow(
        { url: "https://oauth.example.test/token", method: "POST", body: "code=secret-code&code_verifier=secret-verifier", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        (_url, options, onResponse) => request(`http://127.0.0.1:${sourcePort}/token`, options, onResponse),
      )).rejects.toThrow(/redirect/i);
      expect(forwarded).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  });

  it("rejects mismatched state and never exchanges the code", async () => {
    let exchanged = false;
    const flow = new OAuthFlow({
      openBrowser: async (url) => { expect(await get(callback(url, { state: "wrong", code: "sensitive-code" }))).toBe(401); },
      requestToken: async () => { exchanged = true; return { status: 200, text: '{"access_token":"x"}' }; },
    });
    await expect(flow.start(config)).rejects.toThrow(/state/i);
    expect(exchanged).toBe(false);
  });

  it("rejects a callback with a foreign Host header", async () => {
    const flow = new OAuthFlow({
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state")!;
        expect(await get(callback(url, { state, code: "x" }), "evil.example")).toBe(403);
      },
      requestToken: async () => { throw new Error("must not exchange"); },
    });
    await expect(flow.start(config)).rejects.toThrow(/loopback/i);
  });

  it("rejects a provider error after checking state", async () => {
    const flow = new OAuthFlow({
      openBrowser: async (url) => { expect(await get(callback(url, { state: new URL(url).searchParams.get("state")!, error: "access_denied", error_description: "private detail" }))).toBe(400); },
      requestToken: async () => { throw new Error("must not exchange"); },
    });
    const error = await flow.start(config).catch((e: unknown) => e);
    expect(String(error)).toMatch(/denied/i);
    expect(String(error)).not.toContain("private detail");
  });

  it("times out and cancels without exchanging", async () => {
    const timeout = new OAuthFlow({ openBrowser: () => undefined, requestToken: async () => { throw new Error("must not exchange"); }, timeoutMs: 20 });
    await expect(timeout.start(config)).rejects.toThrow(/timed out/i);
    const controller = new AbortController();
    const cancelled = new OAuthFlow({ openBrowser: () => { controller.abort(); }, requestToken: async () => { throw new Error("must not exchange"); } });
    await expect(cancelled.start(config, controller.signal)).rejects.toThrow(/cancelled/i);
  });

  it("rejects malformed token responses without echoing secrets", async () => {
    const flow = new OAuthFlow({
      openBrowser: async (url) => { await get(callback(url, { state: new URL(url).searchParams.get("state")!, code: "sensitive-code" })); },
      requestToken: async () => ({ status: 400, text: '{"error":"sensitive-code","access_token":"access-secret"}' }),
    });
    const error = await flow.start(config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/sensitive-code|access-secret/);
  });

  it("rejects a successful HTTP response without an access token", async () => {
    const flow = new OAuthFlow({
      openBrowser: async (url) => { await get(callback(url, { state: new URL(url).searchParams.get("state")!, code: "code" })); },
      requestToken: async () => ({ status: 200, text: '{"refresh_token":"refresh-secret"}' }),
    });
    await expect(flow.start(config)).rejects.toThrow(/malformed/i);
  });

  it("redacts a transport failure that contains the authorization code", async () => {
    const flow = new OAuthFlow({
      openBrowser: async (url) => { await get(callback(url, { state: new URL(url).searchParams.get("state")!, code: "sensitive-code" })); },
      requestToken: async () => { throw new Error("request failed for sensitive-code"); },
    });
    const error = await flow.start(config).catch((e: unknown) => e);
    expect(String(error)).toMatch(/exchange failed/i);
    expect(String(error)).not.toContain("sensitive-code");
  });
});

describe("device-local OAuth credentials", () => {
  it("stores tokens only in secrets and includes them in redaction", () => {
    const secrets = new Secrets(createApp());
    const channel = { id: "x/main" } as never;
    secrets.setOAuthTokens("x/main", { accessToken: "access-secret", refreshToken: "refresh-secret" });
    expect(secrets.getOAuthTokens("x/main")).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
    expect(secrets.redact("access-secret refresh-secret", allSecretIds([channel]))).toBe("••• •••");
    expect(allSecretIds([channel])).toContain(SecretIds.oauthAccess("x/main"));
    secrets.clearOAuthTokens("x/main");
    expect(secrets.getOAuthTokens("x/main")).toBeNull();
  });

  it("persists only verified or expired health and expiry on this device", () => {
    const app = createApp();
    let device = loadDeviceSettings(app);
    const health = new CredentialHealthStore(() => device, (next) => { device = next; app.saveLocalStorage("osmm-device", next); });
    health.setVerified("x/main", 123456);
    expect(health.get("x/main")).toEqual({ status: "verified", expiresAt: 123456 });
    health.setExpired("x/main");
    expect(health.get("x/main")).toEqual({ status: "expired" });
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toMatch(/access-secret|refresh-secret/);
    health.clear("x/main");
    expect(health.get("x/main")).toBeNull();
  });

  it("discards token fields found in legacy or corrupt local settings", () => {
    const app = createApp();
    app.saveLocalStorage("osmm-device", { credentialHealth: { "x/main": { status: "verified", expiresAt: 123456, accessToken: "access-secret" } } });
    const device = loadDeviceSettings(app);
    expect(device.credentialHealth?.["x/main"]).toEqual({ status: "verified", expiresAt: 123456 });
    expect(JSON.stringify(app.loadLocalStorage("osmm-device"))).not.toContain("access-secret");
  });
});
