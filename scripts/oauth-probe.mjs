import { randomBytes, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';

export const providerDocs = Object.freeze({
  meta: 'https://developers.facebook.com/docs/facebook-login/guides/access-tokens/',
  x: 'https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code',
  linkedin: 'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native',
});

export async function startLoopbackProbe({ state, timeoutMs = 30_000 }) {
  if (typeof state !== 'string' || !state || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('A nonempty state and positive timeout are required');
  }

  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A caller can close before awaiting result; keep that cancellation from becoming unhandled.
  result.catch(() => {});

  let finished = false;
  let timer;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (finished) {
      res.writeHead(410).end('Callback already handled.');
      return;
    }

    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== expectedHost) {
      res.writeHead(403).end('Loopback request required.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end('Callback path required.');
      return;
    }
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
      res.writeHead(401).end('Invalid callback state.');
      return;
    }
    if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
      res.writeHead(400).end('Authorization code required.');
      return;
    }

    finished = true;
    clearTimeout(timer);
    const code = url.searchParams.get('code');
    res.on('finish', () => {
      server.close(() => resolveResult({ code }));
    });
    res.writeHead(200).end('Callback received. You may close this tab.');
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const close = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    rejectResult(new Error('OAuth probe cancelled'));
  };
  timer = setTimeout(async () => {
    if (finished) return;
    finished = true;
    await new Promise((resolve) => server.close(resolve));
    rejectResult(new Error('OAuth probe timed out'));
  }, timeoutMs);

  return {
    redirectUri: `http://127.0.0.1:${server.address().port}/callback`,
    result,
    close,
  };
}

async function selfTest() {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const probe = await startLoopbackProbe({ state, timeoutMs: 5_000 });
  const callback = new URL(probe.redirectUri);
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', randomBytes(24).toString('base64url'));
  const response = await new Promise((resolve, reject) => {
    const req = request(callback, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  await probe.result;
  console.log(JSON.stringify({
    result: response === 200 ? 'loopback callback accepted' : 'loopback callback failed',
    redirectUri: probe.redirectUri,
    pkce: challenge.length === 43 ? 'S256 challenge generated' : 'PKCE generation failed',
    providerDocs,
  }, null, 2));
  if (response !== 200 || challenge.length !== 43) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--self-test') {
    console.error('Usage: node scripts/oauth-probe.mjs --self-test');
    process.exitCode = 2;
  } else {
    selfTest().catch(() => {
      console.error('OAuth probe failed (callback values redacted).');
      process.exitCode = 1;
    });
  }
}
