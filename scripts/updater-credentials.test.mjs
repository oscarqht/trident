import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpdaterCredentialServer, updaterCredentialsResponse } from '../src/lib/updater-credentials.mjs';

const secret = 'fixture-native-secret';
const account = (id, serverUrl = 'https://git.insea.io', type = 'gitlab') => ({
  id, type, serverUrl, username: 'fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01',
});
const request = (headers = {}) => new Request('http://127.0.0.1:3100/api/internal/updater-credentials', { headers });

test('credential server must match the exact HTTPS GitLab origin', () => {
  assert.ok(isUpdaterCredentialServer('https://git.insea.io/'));
  for (const url of ['http://git.insea.io', 'https://git.insea.io.evil.test', 'https://git.insea.io:8443', 'https://git.insea.io/path', 'https://user:pass@git.insea.io', 'invalid', undefined]) {
    assert.equal(isUpdaterCredentialServer(url), false, String(url));
  }
});

test('bridge denies unauthenticated and browser requests before reading credentials', async () => {
  for (const [configured, headers] of [
    [undefined, {}], ['', {}], [secret, {}], [secret, { 'x-trident-token': 'wrong' }],
    [secret, { 'x-trident-token': secret, origin: 'http://127.0.0.1:3100' }],
  ]) {
    let accessed = false;
    const response = await updaterCredentialsResponse(request(headers), {
      secret: configured,
      listCredentials: async () => { accessed = true; return []; },
      getToken: async () => { accessed = true; return 'private-token'; },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Forbidden' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(accessed, false);
  }
});

test('native bridge reads only a matching GitLab credential and skips empty keychain entries', async () => {
  const accessed = [];
  const response = await updaterCredentialsResponse(request({ 'x-trident-token': secret }), {
    secret,
    listCredentials: async () => [account('github', undefined, 'github'), account('other', 'https://gitlab.com'),
      account('spoof', 'https://git.insea.io.evil.test'),
      { ...account('empty'), updatedAt: '2026-10-15' }, account('internal')],
    getToken: async (id) => { accessed.push(id); return id === 'internal' ? ' private-token\n' : null; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: 'private-token' });
  assert.deepEqual(accessed, ['empty', 'internal']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('no matching token returns null; keychain failure never reveals diagnostics or tokens', async () => {
  const dependencies = { secret, listCredentials: async () => [account('other', 'https://gitlab.com')], getToken: async () => 'not-for-updates' };
  const missing = await updaterCredentialsResponse(request({ 'x-trident-token': secret }), dependencies);
  assert.deepEqual(await missing.json(), { token: null });
  const failed = await updaterCredentialsResponse(request({ 'x-trident-token': secret }), {
    ...dependencies, listCredentials: async () => [account('internal')],
    getToken: async () => { throw new Error('sensitive-storage-details'); },
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'Could not load update credentials' });
});
