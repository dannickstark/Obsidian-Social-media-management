import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startLoopbackProbe } from '../../scripts/oauth-probe.mjs';

type Probe = Awaited<ReturnType<typeof startLoopbackProbe>>;
const openProbes: Probe[] = [];

afterEach(async () => {
  await Promise.all(openProbes.splice(0).map((probe) => probe.close()));
});

function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({
      hostname: '127.0.0.1',
      port: Number(target.port),
      path: target.pathname + target.search,
      headers: host ? { Host: host } : undefined,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('loopback OAuth probe', () => {
  it('accepts one matching state and code, then closes the listener', async () => {
    const probe = await startLoopbackProbe({ state: 'expected-state', timeoutMs: 1_000 });
    openProbes.push(probe);
    expect(new URL(probe.redirectUri).hostname).toBe('127.0.0.1');
    const response = await get(`${probe.redirectUri}?state=expected-state&code=private-code`);
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('private-code');
    expect(response.body).not.toContain('expected-state');
    await expect(probe.result).resolves.toEqual({ code: 'private-code' });
    await expect(get(`${probe.redirectUri}?state=expected-state&code=again`)).rejects.toThrow();
  });

  it('rejects a wrong state without consuming the callback', async () => {
    const probe = await startLoopbackProbe({ state: 'expected-state', timeoutMs: 1_000 });
    openProbes.push(probe);
    expect((await get(`${probe.redirectUri}?state=wrong&code=private-code`)).status).toBe(401);
    expect((await get(`${probe.redirectUri}?state=expected-state&code=valid-code`)).status).toBe(200);
    await expect(probe.result).resolves.toEqual({ code: 'valid-code' });
  });

  it('rejects a non-loopback Host header', async () => {
    const probe = await startLoopbackProbe({ state: 'expected-state', timeoutMs: 1_000 });
    openProbes.push(probe);
    const response = await get(`${probe.redirectUri}?state=expected-state&code=private-code`, 'example.com');
    expect(response.status).toBe(403);
    expect(response.body).not.toContain('private-code');
    expect((await get(`${probe.redirectUri}?state=expected-state&code=valid-code`)).status).toBe(200);
    await expect(probe.result).resolves.toEqual({ code: 'valid-code' });
  });

  it('times out and closes without a callback', async () => {
    const probe = await startLoopbackProbe({ state: 'expected-state', timeoutMs: 30 });
    openProbes.push(probe);
    await expect(probe.result).rejects.toThrow('OAuth probe timed out');
    await expect(get(`${probe.redirectUri}?state=expected-state&code=late`)).rejects.toThrow();
  });
});
